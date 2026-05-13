# Auto-Deactivation on Plan Completion

**Status**: Design (pre-implementation — T15 owns impl, T16 owns tests)
**Closed decision**: F4 APPROVE is the sole trigger. F1/F2/F3 entries are NOT
sufficient. Do not re-litigate. (Plan line 306.)

---

## 1. Context and Motivation

`boulder_progress` (servers/tools/boulder.py:65) is the natural place to detect
that a plan run is finished. It already computes `is_complete = (remaining == 0
and total > 0)` (line 105). Today that flag sits in the returned JSON; nothing
acts on it. Four stale mode files — ralph-state.json, ultrawork-state.json,
boulder.json, pending-final-verify.json — are left on disk after plan
completion, causing confusing `mode_read` output and requiring a manual
`mode_clear` call.

The fix: when `boulder_progress` sets `is_complete=true` AND a matching F4
APPROVE evidence entry exists for the active plan, automatically clear those
four modes and annotate the response payload.

---

## 2. Trigger Location

**File**: `servers/tools/boulder.py`
**Function**: `boulder_progress` (line 65)
**Augmentation point**: after line 107 (`result = {..., "is_complete": ...}`),
before `return json.dumps(result, indent=2)` (line 108).

Pseudocode sketch (implementation goes here, not in this document):

```python
if result["is_complete"]:
    result.update(_maybe_auto_deactivate(state, active_plan_sha256=..., working_directory=working_directory))
```

`_maybe_auto_deactivate` is defined as a plain module-level function in
`boulder.py` — not an MCP-decorated tool, so it has no decorator side-effects
and cannot trigger the MCP dispatch loop.

---

## 3. `_load_evidence()` Helper Extraction

### Requirement

Both the existing MCP `evidence_read` tool (evidence.py:60) and the new
auto-deactivate path need to load `verification-evidence.json`. They MUST share
a single reader. The MCP-decorated `evidence_read` function is off-limits as a
call target from `boulder.py`:

- The `@mcp.tool()` decorator wraps the function in FastMCP dispatch machinery;
  calling it directly from another module is calling the wrapper, not the
  underlying logic.
- It would also introduce a cross-module closure dependency that defeats the
  existing clean separation of `boulder.py` and `evidence.py`.

### Solution

Extract a plain function `_load_evidence(state_dir: str) -> list[dict]` in
`tools/_common.py` (alongside `_read_json`, `_write_json`, etc.). The function
returns the entries list (empty list on any read/parse failure — never raises).

```python
# _common.py — new helper (implementation in T15)
def _load_evidence(state_dir: str) -> list[dict]:
    """Return evidence entries list; empty list on any failure."""
    path = os.path.join(state_dir, EVIDENCE_FILE)
    try:
        data = _read_json(path)          # already swallows FileNotFoundError + JSONDecodeError
        return data.get("entries", [])
    except Exception:
        return []
```

`evidence_read` in evidence.py is then simplified to call `_load_evidence(state)`
and format the result. `_maybe_auto_deactivate` in boulder.py imports
`_load_evidence` from `tools._common`.

---

## 4. F4 Match Algorithm

### Inputs

- `entries`: list returned by `_load_evidence(state_dir)`
- `active_plan_sha256`: SHA-256 hex digest of the active plan file content,
  computed in `boulder_progress` from the already-opened plan file.

### Algorithm (pseudocode)

```python
def _has_f4_approve(entries: list[dict], active_plan_sha: str) -> bool:
    for entry in entries:
        # Must be scoped to this plan run
        if entry.get("plan_sha256", "") != active_plan_sha:
            continue
        # Must be an F4 entry
        if not entry.get("type", "").startswith("final_verification_f4"):
            continue
        # APPROVE verdict: exit_code 0 or explicit APPROVE token in snippet
        if entry.get("exit_code", -1) == 0:
            return True
        snippet = entry.get("output_snippet", "").upper()
        if "APPROVE" in snippet or "APPROVED" in snippet:
            return True
    return False
```

**Why `startswith("final_verification_f4")` not exact equality**: users
occasionally suffix the type (e.g. `final_verification_f4_security`). The
prefix constraint is tight enough and forward-compatible.

**Why `plan_sha256` gate is mandatory**: evidence from a prior run of the same
plan file (different SHA) MUST NOT trigger auto-clear of the current run's modes.
If the agent omitted `plan_sha256` on its F4 entry, that entry is not matched
and auto-deactivation does not fire — a deliberate fail-safe.

---

## 5. `_maybe_auto_deactivate` Function

### Signature

```python
def _maybe_auto_deactivate(
    state: str,
    active_plan_sha256: str,
    working_directory: str,
) -> dict:
    """
    If F4 APPROVE evidence matches active plan, clear ralph/ultrawork/boulder/
    final_verify and return {auto_deactivated: True, cleared: [...]}.
    Never raises; always returns a dict safe to merge into boulder_progress result.
    """
```

### Internal mode-clear implementation

Do NOT call the MCP `mode_clear` tool — same decorator-invocation problem.
Instead, call the underlying file-removal logic directly. The `mode_clear`
implementation in boulder.py:160 is itself a nested function; its logic must be
extracted into a private helper `_clear_mode_files(state: str, modes: list[str])
-> list[str]` that does the `os.remove` loop (lines 204-214). Both the MCP
`mode_clear` tool and `_maybe_auto_deactivate` call this helper.

Clear order: ralph → ultrawork → boulder → final_verify. Evidence is NEVER
cleared (audit trail).

### Fail-safe requirement

`_maybe_auto_deactivate` MUST NOT raise. Any exception during evidence read,
SHA computation, or file removal is caught; the function returns:

```python
{"auto_deactivated": False, "reason": "internal_error"}
```

`boulder_progress` itself must not raise as a result of this augmentation.

---

## 6. Response Payload Shapes

All four cases must be covered.

### 6a. Incomplete plan

Response unchanged from current (no `auto_deactivated` key). No overhead on the
hot path.

### 6b. Complete + F4 APPROVE match

```json
{
  "total": 14,
  "completed": 14,
  "remaining": 0,
  "is_complete": true,
  "plan_path": "/path/to/plan.md",
  "auto_deactivated": true,
  "cleared": ["ralph", "ultrawork", "boulder", "final_verify"]
}
```

### 6c. Complete + no F4 match

```json
{
  "total": 14,
  "completed": 14,
  "remaining": 0,
  "is_complete": true,
  "plan_path": "/path/to/plan.md",
  "auto_deactivated": false,
  "reason": "no_matching_f4_approve"
}
```

### 6d. Complete + F4 match but evidence read failed

```json
{
  "total": 14,
  "completed": 14,
  "remaining": 0,
  "is_complete": true,
  "plan_path": "/path/to/plan.md",
  "auto_deactivated": false,
  "reason": "evidence_read_failed"
}
```

This keeps `boulder_progress` useful even when the state dir is partially
corrupt.

---

## 7. User-Visible Signal

When auto-deactivation fires, emit a single line to stderr so the user (and any
log scraper) sees it:

```python
import sys
print(
    f"omca: plan complete + F4 APPROVE detected; auto-cleared "
    f"ralph/ultrawork/boulder/final_verify modes",
    file=sys.stderr,
)
```

One line, no emoji, emitted once per `boulder_progress` call that triggers
auto-clear. Do not emit on the no-match or error paths.

---

## 8. SHA-256 Computation

`boulder_progress` already has the plan file content in memory (line 84, `with
open(plan_path) as f: content = f.read()`). Compute the SHA immediately after:

```python
import hashlib
active_plan_sha256 = hashlib.sha256(content.encode()).hexdigest()
```

Pass it into `_maybe_auto_deactivate`. No additional file I/O.

---

## 9. File Change Summary (for T15)

| File | Change |
|------|--------|
| `servers/tools/_common.py` | Add `_load_evidence(state_dir) -> list[dict]` |
| `servers/tools/_common.py` | Add `_clear_mode_files(state, modes) -> list[str]` |
| `servers/tools/evidence.py` | Simplify `evidence_read` to use `_load_evidence` |
| `servers/tools/boulder.py` | Add `_has_f4_approve(entries, sha) -> bool` |
| `servers/tools/boulder.py` | Add `_maybe_auto_deactivate(state, sha, wd) -> dict` |
| `servers/tools/boulder.py` | Refactor `mode_clear` to use `_clear_mode_files` |
| `servers/tools/boulder.py` | Augment `boulder_progress` at line 107 with SHA + deactivate call |

---

## 10. Test Surface for T16

T16 should use a `synthetic_state_dir` pytest fixture that:

1. Creates a temp directory tree mirroring `.omca/state/` structure.
2. Writes a minimal plan file with all-checked checkboxes.
3. Writes a `verification-evidence.json` with a controlled entries list.
4. Writes `ralph-state.json`, `ultrawork-state.json`, `boulder.json`,
   `pending-final-verify.json` as non-empty JSON blobs.
5. Patches `_state_dir` to return the temp dir.

Key test cases:

- `test_auto_deactivate_fires`: F4 entry with matching SHA + exit 0 → files
  removed, payload has `auto_deactivated=true`.
- `test_no_deactivate_wrong_sha`: F4 entry present but SHA mismatch → no files
  removed, payload `reason=no_matching_f4_approve`.
- `test_no_deactivate_f3_only`: only F3 entry → not matched, no auto-clear.
- `test_no_deactivate_incomplete_plan`: plan has unchecked boxes → augmentation
  not reached at all.
- `test_deactivate_survives_missing_evidence_file`: `verification-evidence.json`
  absent → `reason=evidence_read_failed`, no exception raised.
- `test_evidence_never_cleared`: after auto-deactivate, `verification-evidence.json`
  still exists.

---

## 11. Closed Decisions (non-negotiable)

| Decision | Resolution |
|----------|------------|
| Which evidence type triggers? | `final_verification_f4` prefix only (plan line 306) |
| Import MCP-decorated `evidence_read`? | Forbidden — use `_load_evidence` helper |
| SessionEnd or external watcher as trigger? | Rejected (plan line 305) — trigger is inside `boulder_progress` |
| Auto-clear evidence? | Never — audit trail is permanent |
| What if `boulder_progress` is called while another session clears modes? | Acceptable TOCTOU; tool is idempotent, files simply won't be found |
