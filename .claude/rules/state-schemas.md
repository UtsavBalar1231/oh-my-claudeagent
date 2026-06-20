# State File Schemas

Canonical schemas for every JSON file written under `${HOOK_STATE_DIR}` (defaults to
`.omca/state/` relative to the project root). Each entry documents: path, writer(s),
lifecycle, field table, and a minimal JSON example. Cross-references between schemas
are noted where fields share identity semantics.

`HOOK_STATE_DIR` is set by `scripts/lib/common.sh` line 8:
`HOOK_STATE_DIR="${HOOK_STATE_DIR:-${HOOK_PROJECT_ROOT}/.omca/state}"`.

---

## boulder.json

**Path**: `.omca/state/boulder.json`
**Writers**: `boulder_write` MCP tool (`servers/tools/boulder.py`)
**Readers**: `scripts/subagent-start.sh` (plan context injection),
`scripts/final-verification-evidence.sh` (completeness check), `boulder_progress` MCP tool
**Lifecycle**:
1. Written by `/oh-my-claudeagent:start-work` via `boulder_write(active_plan, plan_name, session_id)`.
2. On session resume, `boulder_write` is called again — `session_id` is appended to
   `session_ids[]` (no duplicates), `started_at` is preserved from the first write.
3. Removed when deleted manually or via direct file removal (no MCP clear tool remains).
4. `boulder_progress` derives remaining/total task counts at read time from the plan file (not stored in the boulder file).

**Fields**:

| Field | Type | Description |
|---|---|---|
| `active_plan` | string | Absolute path to the plan file |
| `started_at` | string | ISO-8601 UTC timestamp of first `boulder_write` call |
| `session_ids` | array of string | Accumulated session IDs across all resumes |
| `plan_name` | string | Short human-readable name for the plan |
| `agent` | string | Agent managing the plan (default `"sisyphus"`) |
| `worktree_path` | string | (optional) Git worktree path if using `isolation: worktree` |

**Example**:
```json
{
  "active_plan": "/home/user/.claude/plans/my-plan.md",
  "started_at": "2026-05-10T10:00:00Z",
  "session_ids": ["sess-001", "sess-002"],
  "plan_name": "my-plan",
  "agent": "sisyphus"
}
```

**Note**: `boulder_progress` derives `plan_exists` at read time by checking whether
`active_plan` points to an existing file. This boolean is never written to disk.

---

## verification-evidence.json

**Path**: `.omca/evidence/verification-evidence.json`
**Writers**: `evidence_log` MCP tool (`servers/tools/evidence.py`) — the ONLY valid
writer. Manual writes are blocked by `scripts/write-guard.sh` (`PreToolUse Write` hook)
and rejected by schema validation in `scripts/task-completed-verify.sh`.
**Readers**: `scripts/task-completed-verify.sh` (schema validation + freshness check),
`scripts/final-verification-evidence.sh` (final_verification completeness check),
`evidence_read` MCP tool
**Lifecycle**:
1. Created (or appended to) by each `evidence_log(...)` call.
2. Entries accumulate for the session; the file is NOT reset between tasks.
3. `task-completed-verify.sh` checks mtime freshness (<=300s) and validates schema.
4. `final-verification-evidence.sh` checks for a `final_verification` entry at session Stop
   when boulder.json reports a completed plan.
5. NOT cleared automatically — evidence is a permanent audit trail. Remove manually if needed.
6. `output_snippet` is capped to 2000 characters by `evidence_log`.

**Fields**:

| Field | Type | Description |
|---|---|---|
| `entries` | array | All recorded evidence entries |
| `entries[].type` | string | Evidence category — see type enum below |
| `entries[].command` | string | Command or action that was executed |
| `entries[].exit_code` | integer | Exit code (0 = success) |
| `entries[].output_snippet` | string | Relevant output, capped at 2000 chars |
| `entries[].timestamp` | string | ISO-8601 UTC timestamp |
| `entries[].verified_by` | string | (optional) Agent or user who verified |

**Type enum**:

| Value | Meaning |
|---|---|
| `build` | Compilation or build command |
| `test` | Test suite run |
| `lint` | Linter or static-analysis run |
| `manual` | Manual verification step |
| `final_verification` | End-of-plan completeness review |

**Example**:
```json
{
  "entries": [
    {
      "type": "test",
      "command": "just test",
      "exit_code": 0,
      "output_snippet": "10 passed, 0 failed",
      "timestamp": "2026-05-10T12:05:00Z",
      "verified_by": "executor"
    },
    {
      "type": "final_verification",
      "command": "final-verification-evidence.sh: plan complete + evidence present",
      "exit_code": 0,
      "output_snippet": "verdict:APPROVE",
      "timestamp": "2026-05-10T12:10:00Z"
    }
  ]
}
```

---

## active-modes.json

**Path**: `.omca/state/active-modes.json`
**Writers**: `scripts/keyword-detector.sh` (`UserPromptSubmit` hook)
**Readers**: `scripts/keyword-detector.sh` (re-announcement suppression),
`scripts/subagent-start.sh` (mode injection via `mode_is_active` from `common.sh`)
**Lifecycle**:
1. Written on first keyword detection in a session; mode entry is stamped with
   `detected_at` epoch and `session_id`.
2. `mode_already_announced()` in `keyword-detector.sh` checks if `session_id` matches
   current session — if yes, suppresses re-announcement.
3. File is NOT cleared automatically; remove manually to reset keyword re-announce suppression.

**Top-level structure**: a plain object keyed by mode name. Each value is a mode-entry
object.

**Fields**:

| Field | Type | Description |
|---|---|---|
| `<mode_name>` | object | One key per detected mode (see modes below) |
| `<mode_name>.detected_at` | integer | Unix epoch when mode was first detected |
| `<mode_name>.session_id` | string | `CLAUDE_SESSION_ID` at detection time |

**Known mode keys**: `handoff`, `omca-setup`, `metis`, `plan`, `hephaestus`.

**Example**:
```json
{
  "handoff": {
    "detected_at": 1746878400,
    "session_id": "sess-001"
  },
  "hephaestus": {
    "detected_at": 1746878500,
    "session_id": "sess-001"
  }
}
```

**Note**: `keyword-detector.sh` reads this file to suppress re-announcement of modes
already detected in the current session.

---

## error-counts.json

**Path**: `.omca/state/error-counts.json`
**Writers**: `scripts/delegate-retry.sh` (`PostToolUseFailure Agent` hook),
`scripts/edit-error-recovery.sh` (`PostToolUseFailure Edit` hook), other
`*-error-recovery.sh` scripts for their respective tools
**Readers**: `scripts/delegate-retry.sh`, `scripts/edit-error-recovery.sh` (circuit
breaker at 3+ errors)
**Lifecycle**:
1. Created on first error encounter; updated atomically per error event.
2. Key format: `"<tool_name>:<error_kind>"` where `tool_name` comes from
   `.tool_name // "Agent"` (or `// "Edit"` etc.) in the hook payload.
3. Values are cumulative integers — NOT reset each session.

**Fields** (the schema is an open object; known keys are below):

| Key | Type | Description |
|---|---|---|
| `"Agent:delegate_error"` | integer | Delegation failures via the Agent tool |
| `"Edit:edit_error"` | integer | Edit tool failures |
| `"Bash:bash_error"` | integer | Bash tool failures (from `bash-error-recovery.sh`) |
| `"Read:read_error"` | integer | Read tool failures (from `read-error-recovery.sh`) |
| `"<tool>:<kind>"` | integer | General pattern; any tool name and error kind |

**Example**:
```json
{
  "Agent:delegate_error": 2,
  "Edit:edit_error": 1
}
```

**Circuit breaker**: once any key reaches ≥ 3, the corresponding recovery script
appends a hard-stop instruction to the context: "Stop retrying the same approach.
Escalate to oracle."

---

## Cross-cutting invariants

### Session ID staleness
`active-modes.json` stores `session_id` to enable cross-session re-announce suppression.
`keyword-detector.sh` checks `session_id` and suppresses a second announcement only if it
matches the current session.

### Atomic writes
All state files are written atomically: `tmp=$(mktemp) && jq ... > "$tmp" && mv "$tmp"
target.json`. Never write to state files directly; use the designated MCP tools or hook
scripts. `verification-evidence.json` additionally rejects direct writes via the
`write-guard.sh` PreToolUse hook.
