# State File Schemas

Canonical schemas for every JSON file written under `${HOOK_STATE_DIR}` (defaults to
`.omca/state/` relative to the project root). Each entry documents: path, writer(s),
lifecycle, field table, and a minimal JSON example. Cross-references between schemas
are noted where fields share identity semantics.

`HOOK_STATE_DIR` is set by `scripts/lib/common.sh` line 8:
`HOOK_STATE_DIR="${HOOK_STATE_DIR:-${HOOK_PROJECT_ROOT}/.omca/state}"`.

---

## boulder.json

`boulder.json` is a session-bound plan **registry**, not a single-plan pointer. Multiple
plans can be tracked concurrently (one per `plans[plan_name]` entry); each session binds
to exactly one of them via `bindings[session_id]`.

**Path**: `.omca/state/boulder.json`
**Writers**:
- `boulder_write` MCP tool (`servers/tools/boulder.py`, via `_do_boulder_write`) — the
  only writer of `plans[plan_name]` and the only creator of `bindings[session_id]`.
- `scripts/session-cleanup.sh` (`SessionEnd` hook) — removes only this session's
  binding (`del(.bindings[session_id])`) when `reason != "resume"`. Never touches `plans`.

**Readers**:
- `scripts/subagent-start.sh` — resolves the bound plan via the `boulder_resolve.py` shim.
- `scripts/final-verification-evidence.sh` — resolves via the same shim, then compares
  the plan's live `sha256sum` against logged `final_verification` evidence.
- `scripts/session-init.sh` — resolves via the same shim to set `sessionTitle` from the
  bound plan's name (read-only, no write-back).
- `statusline/core.py` — reads `boulder.json` directly and calls `resolve_bound_plan()`
  from `_boulder_core` in-process (Python, so no shim needed) to show plan progress.
- `boulder_progress` MCP tool — resolves by `plan_name`, by session binding, or takes an
  explicit `plan_path`, then derives task counts from the plan file's checkboxes.

**Schema** (registry shape):

```json
{
  "plans": {
    "<plan_name>": {
      "active_plan": "string — absolute path to the plan file",
      "started_at": "string — ISO-8601 UTC timestamp of first boulder_write for this plan",
      "session_ids": ["array of string — every session_id that has touched this plan"],
      "agent": "string — agent managing the plan, default \"sisyphus\"",
      "worktree_path": "string — optional, present only when isolation: worktree was used"
    }
  },
  "bindings": {
    "<session_id>": {
      "plan_name": "string — key into plans{}",
      "bound_at": "integer — Unix epoch seconds when this session bound to the plan"
    }
  }
}
```

**Example**:
```json
{
  "plans": {
    "my-plan": {
      "active_plan": "/home/user/.claude/plans/my-plan.md",
      "started_at": "2026-05-10T10:00:00Z",
      "session_ids": ["sess-001", "sess-002"],
      "agent": "sisyphus"
    },
    "other-plan": {
      "active_plan": "/home/user/.claude/plans/other-plan.md",
      "started_at": "2026-05-12T08:00:00Z",
      "session_ids": ["sess-003"],
      "agent": "sisyphus",
      "worktree_path": "/home/user/repo/.claude/worktrees/other-plan"
    }
  },
  "bindings": {
    "sess-002": { "plan_name": "my-plan", "bound_at": 1746878400 },
    "sess-003": { "plan_name": "other-plan", "bound_at": 1746900000 }
  }
}
```

**Resolution — `resolve_bound_plan` (in `servers/tools/_boulder_core.py`)**:

Pure-read function, called by every reader above (directly in Python, or via the
`boulder_resolve.py` shim from bash). It never writes. Ladder, in order:
1. This session has an explicit `bindings[session_id]` whose `plan_name` still exists
   in `plans` → return that plan.
2. Exactly one plan is registered → return it (single-plan case needs no binding).
3. Multiple plans, no binding for this session → return the plan with the most recent
   `started_at`.
4. No plans registered → `{}`.

**`boulder_resolve.py`** (`servers/tools/boulder_resolve.py`) is a stdlib-only,
bash-callable wrapper around `resolve_bound_plan`: `python3 boulder_resolve.py
[session_id] [working_directory]`, prints the resolved `{plan_name, active_plan,
worktree_path}` triple as JSON (or `{}`) and always exits 0 — bash readers should shell
out to this shim rather than hand-parsing `boulder.json`, so every reader stays on the
exact same resolution ladder as the Python writer.

**Completion is derived, not stored**. There is no `completed_at` field — a plan's
completion is computed on demand from its own `- [ ] N.` / `- [x] N.` checkboxes
(`_plan_is_complete` in `boulder.py`, sharing the `_CHECKBOX_RE` pattern with
`statusline/core.py`). A plan with no checkboxes at all is never considered complete.

**GC policy** — two layers:
1. **Primary, at `SessionEnd`**: `scripts/session-cleanup.sh` deletes this session's
   `bindings[session_id]` entry under an exclusive `flock` on a *separate* lock file,
   `.omca/state/boulder.json.lock` — the same lock file `boulder.py` uses for its
   read-modify-write, so the two writers never race. Runs only when the end reason is
   not `"resume"`. Never deletes `plans` entries.
2. **Backstop, on every `boulder_write`**: `_gc_prune()` in `boulder.py` prunes (a) any
   binding whose `bound_at` is older than `GC_MAX_AGE_SECONDS` (7 days, i.e.
   `7 * 24 * 3600`) — covers sessions that never hit a clean `SessionEnd` — and (b) any
   plan that is simultaneously unbound (no binding references it), older than the same
   7-day threshold, and checkbox-complete. Incomplete or actively-bound plans are never
   pruned, no matter their age.

**Migration (lazy, old → new)**: `normalize()` in `_boulder_core.py` detects the old
flat single-plan schema (top-level `active_plan` key, no `plans`/`bindings`) via
`is_flat_schema()` and converts it to the registry shape in memory via
`migrate_flat_to_registry()` on every read. The migration is never persisted as a
side effect of a read — the file on disk stays in the old shape until the next
`boulder_write` call writes the registry shape back out.

**Concurrency**: all registry mutations happen under an exclusive `flock` on
`.omca/state/boulder.json.lock` (a file separate from the data file itself, avoiding
the inode-swap footgun where `os.replace` on the data file races a lock held on it).
Writes use `tempfile.mkstemp(dir=state_dir, ...)` + `os.replace()` — never a fixed
temp path, so two writers can never collide on the same temp file even inside the
same lock window.

**Session ID note**: `_resolve_session_id` (Python/MCP side, `servers/tools/_common.py`)
reads the `CLAUDE_CODE_SESSION_ID` env var — this is the authoritative key used for
every `bindings{}` key written by `boulder_write`. The bash-side `resolve_session_id`
(`scripts/lib/common.sh`) checks a differently-named env var (`CLAUDE_SESSION_ID`) first
and falls back to the hook payload's `.session_id` / `session.json`'s `.sessionId` —
in practice these resolve to the same underlying platform session identifier, but the
env var name itself is not shared between the bash and Python layers.

---

## injected-context-dirs.json

**Path**: `.omca/state/injected-context-dirs.json`
**Writers**: `scripts/context-injector.sh` (`PostToolUse Read|Write|Edit` hook)
**Readers**: `scripts/context-injector.sh` (dedup check before each injection)
**Lifecycle**:
1. Reset to `{}` by `scripts/session-init.sh` on every `SessionStart` — dedup state is
   per-session by construction, so no separate GC/expiry logic is needed.
2. Populated incrementally as `context-injector.sh` injects AGENTS.md/README.md content
   and `.omca/rules/*.md` rule bodies.
3. Never cleared mid-session; only reset at the next `SessionStart`.

**Top-level structure**: a flat object keyed by dedup key, all values are the string
`"true"`. Two disjoint key families share this file:

| Key family | Format | Meaning |
|---|---|---|
| AGENTS.md / README.md | `"<dir>\|<AGENTS.md mtime>"` | One entry per directory walked during a Read event; mtime-keyed so editing AGENTS.md invalidates the cache and re-injects |
| `.omca/rules/*.md` | `"rule:<realpath-of-rule-file>:<sha256-of-injected-body>"` | One entry per matched rule; realpath so a rule reached via a symlinked path collapses to the same key, content-hash so editing the rule re-injects it |

**Example**:
```json
{
  "/home/user/project/src|1746878400": "true",
  "rule:/home/user/project/.omca/rules/react.md:1f3d9e2a...": "true"
}
```

**Note**: the two key families never collide — directory keys always contain a literal
`|`, rule keys always start with the literal prefix `rule:`.

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

## subagent-models.json

**Path**: `.omca/state/subagent-models.json`
**Writers**: `scripts/subagent-start.sh` (`SubagentStart` hook)
**Readers**: statusline renderer (shows each live subagent's real model)
**Lifecycle**:
1. Upserted on every `SubagentStart` event that carries a non-empty `agent_id`.
2. Reset to `{}` by `scripts/session-init.sh` on `SessionStart` (session-scoped,
   mirrors the `injected-context-dirs.json` reset).
3. No `SubagentStop` cleanup — the renderer only shows live tasks, so stale
   entries left after a subagent finishes are simply never displayed.

**Top-level structure**: a plain object keyed by `agent_id` (unique per spawned
subagent instance).

**Fields**:

| Field | Type | Description |
|---|---|---|
| `<agent_id>.agent_type` | string | Raw `agent_type` from the SubagentStart payload (e.g. `oh-my-claudeagent:executor`) |
| `<agent_id>.model` | string | Friendly display name resolved from the agent's frontmatter `model:` field, or `""` if unresolvable |

**Model resolution**: strip the `oh-my-claudeagent:` prefix from `agent_type`,
read `${CLAUDE_PLUGIN_ROOT}/agents/<name>.md` frontmatter `model:`, map via a
small case statement (`claude-opus-4-8`→`Opus 4.8`, `sonnet`→`Sonnet`,
`haiku`→`Haiku`, `claude-sonnet-5`→`Sonnet 5`, else the raw value). Non-OMCA
agent types (e.g. `explore`, `general-purpose`) have no matching frontmatter
file, so `model` is stored as `""` and the renderer shows no model.

**Example**:
```json
{
  "agent-abc123": {
    "agent_type": "oh-my-claudeagent:executor",
    "model": "Sonnet"
  },
  "agent-def456": {
    "agent_type": "oh-my-claudeagent:sisyphus",
    "model": "Opus 4.8"
  }
}
```

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
