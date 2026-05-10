# State File Schemas

Canonical schemas for every JSON file written under `${HOOK_STATE_DIR}` (defaults to
`.omca/state/` relative to the project root). Each entry documents: path, writer(s),
lifecycle, field table, and a minimal JSON example. Cross-references between schemas
are noted where fields share identity semantics.

`HOOK_STATE_DIR` is set by `scripts/lib/common.sh` line 8:
`HOOK_STATE_DIR="${HOOK_STATE_DIR:-${HOOK_PROJECT_ROOT}/.omca/state}"`.

---

## subagents.json

**Path**: `.omca/state/subagents.json`
**Writers**: `scripts/track-subagent-spawn.sh` (creates entry), `scripts/subagent-start.sh`
(bridges spawn-ID to platform agent_id), `scripts/subagent-complete.sh` (moves entry to
`completed`)
**Readers**: `scripts/agent-usage-reminder.sh`, `scripts/subagent-complete.sh`
(remaining-count check)
**Lifecycle**:
1. Initialized as `{"active":[],"completed":[]}` by `track-subagent-spawn.sh` if absent.
2. `PreToolUse Agent` fires `track-subagent-spawn.sh` — appends an entry to `.active[]`
   with a synthetic `spawn-*` ID.
3. `SubagentStart` fires `subagent-start.sh` — locates the matching `spawn-*` entry by
   `type` and overwrites `.id` with the platform `agent_id` and stamps `started_epoch`.
4. `SubagentStop` fires `subagent-complete.sh` — moves entry from `.active` to `.completed`.

**Fields**:

| Field | Type | Description |
|---|---|---|
| `active` | array | In-flight subagents |
| `active[].id` | string | Platform `agent_id` (after SubagentStart bridge); `spawn-<epoch><rand>` before bridge |
| `active[].type` | string | `tool_input.subagent_type` from hook payload (e.g. `oh-my-claudeagent:executor`) |
| `active[].model` | string | `tool_input.model` or `"default"` |
| `active[].promptPreview` | string | First 200 chars of `tool_input.prompt` |
| `active[].startedAt` | string | ISO-8601 timestamp from `track-subagent-spawn.sh` |
| `active[].status` | string | `"running"` (set on spawn; no update to active entries) |
| `active[].started_epoch` | integer | Unix epoch, written by `subagent-start.sh` ID-bridge |
| `completed` | array | Finished subagents |
| `completed[].id` | string | Platform `agent_id` |
| `completed[].completedAt` | string | ISO-8601 timestamp |
| `completed[].status` | string | Always `"completed"` (SubagentStop has no exit_status field) |

**Example**:
```json
{
  "active": [
    {
      "id": "agent-abc123",
      "type": "oh-my-claudeagent:executor",
      "model": "sonnet",
      "promptPreview": "Fix the auth bug in login.ts...",
      "startedAt": "2026-05-10T12:00:00+00:00",
      "status": "running",
      "started_epoch": 1746878400
    }
  ],
  "completed": [
    {
      "id": "agent-xyz789",
      "completedAt": "2026-05-10T11:59:00+00:00",
      "status": "completed"
    }
  ]
}
```

**Cross-references**: `active[].id` is the same platform `agent_id` that appears in
`active-agents.json[].id`. Both files must be consulted together to get a complete view
of running agents — they lag each other during the spawn race window.

---

## active-agents.json

**Path**: `.omca/state/active-agents.json`
**Writers**: `scripts/subagent-start.sh` (appends entry), `scripts/subagent-complete.sh`
(removes entry via flock-protected write)
**Readers**: `scripts/agent-usage-reminder.sh`, `scripts/track-subagent-spawn.sh`
(concurrency check), `scripts/subagent-complete.sh` (duration calculation)
**Lifecycle**:
1. `SubagentStart` fires `subagent-start.sh` — flock-protected append of new entry.
2. `SubagentStop` fires `subagent-complete.sh` — flock-protected removal of the matching
   entry; entries older than 900s (15m TTL) are also swept.
3. File is an array (no wrapper object). Absence treated as `[]` by readers.

**Fields**:

| Field | Type | Description |
|---|---|---|
| `[].id` | string | Platform `agent_id` from `SubagentStart` hook payload |
| `[].agent` | string | `agent_type` from hook payload (e.g. `oh-my-claudeagent:executor`) |
| `[].model` | string | Resolved model alias (`sonnet`, `opus`, etc.) |
| `[].started` | string | ISO-8601 timestamp |
| `[].started_epoch` | integer | Unix epoch; used by `subagent-complete.sh` for duration calculation |

**Example**:
```json
[
  {
    "id": "agent-abc123",
    "agent": "oh-my-claudeagent:executor",
    "model": "sonnet",
    "started": "2026-05-10T12:00:00+00:00",
    "started_epoch": 1746878400
  }
]
```

**Cross-references**: `[].id` matches `subagents.json active[].id`. The union of IDs from
both files is the authoritative running-agent set — `agent-usage-reminder.sh` computes:
```
([$aa[].id] + [$sa[].id]) | unique | length
```
where `$aa` = `active-agents.json` and `$sa` = `subagents.json .active`.

**Concurrency lock**: writes to this file are guarded by `.omca/state/active-agents.lock`
via `flock -w 5`.

---

## boulder.json

**Path**: `.omca/state/boulder.json`
**Writers**: `boulder_write` MCP tool (`servers/tools/boulder.py`)
**Readers**: `scripts/subagent-start.sh` (plan context injection), `scripts/ralph-persistence.sh`,
`scripts/final-verification-evidence.sh`, `mode_read` MCP tool
**Lifecycle**:
1. Written by `/oh-my-claudeagent:start-work` via `boulder_write(active_plan, plan_name, session_id)`.
2. On session resume, `boulder_write` is called again — `session_id` is appended to
   `session_ids[]` (no duplicates), `started_at` is preserved from the first write.
3. Cleared by `mode_clear(mode="boulder"|"all")` — removes the file entirely.
4. `mode_read()` adds a derived `plan_exists` boolean (not stored in the file).

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
  "active_plan": "/home/user/project/.claude/plans/my-plan.md",
  "started_at": "2026-05-10T10:00:00Z",
  "session_ids": ["sess-001", "sess-002"],
  "plan_name": "my-plan",
  "agent": "sisyphus"
}
```

**Note**: `mode_read()` synthesizes a `plan_exists` boolean at read time by checking
`os.path.isfile(active_plan)`. This field is never written to disk.

---

## pending-final-verify.json

**Path**: `.omca/state/pending-final-verify.json`
**Writers**: The `/oh-my-claudeagent:start-work` command body (LLM instruction in
`commands/start-work.md` lines 243-256) — written by the orchestrating agent after
flipping the last `- [ ]` checkbox
**Readers**: `scripts/final-verification-evidence.sh` (validates cross-session, checks
for F1-F4 evidence), `scripts/session-init.sh` (orphan-marker sweep)
**Lifecycle**:
1. Written UNCONDITIONALLY after the last plan checkbox is flipped, before running F1-F4.
2. `session-init.sh` sweeps orphaned markers on session start: if `session_id` in the
   file differs from `CLAUDE_SESSION_ID`, the file is deleted (cross-session orphan
   guard). Skipped on compact-triggered reinit.
3. `final-verification-evidence.sh` (Stop hook) uses this marker to determine if F1-F4
   evidence is required. Cleared once all four F-type evidence entries for the recorded
   `plan_sha256` are present, or manually via `mode_clear(mode="final_verify"|"all")`.

**Fields**:

| Field | Type | Description |
|---|---|---|
| `plan_path` | string | Absolute path to the plan file |
| `plan_sha256` | string | SHA-256 hex digest of the plan file at freeze time (after last checkbox flip) |
| `marked_at` | integer | Unix epoch timestamp when marker was written |
| `session_id` | string | `CLAUDE_SESSION_ID` at write time; used for cross-session staleness detection |

**Example**:
```json
{
  "plan_path": "/home/user/project/.claude/plans/my-plan.md",
  "plan_sha256": "ad649112c6e13e3d7984a3b4ffed9c3551baf0edfdc3516dc3b573cd81b20a9d",
  "marked_at": 1746878400,
  "session_id": "sess-001"
}
```

**Cross-references**: `plan_sha256` must match the `plan_sha256` field on F1-F4 entries
in `verification-evidence.json`. `final-verification-evidence.sh` requires either
first-class `.plan_sha256 == <sha>` or embedded `"plan_sha256:<sha>"` in
`.output_snippet` for each F1-F4 entry.

---

## verification-evidence.json

**Path**: `.omca/state/verification-evidence.json`
**Writers**: `evidence_log` MCP tool (`servers/tools/evidence.py`) — the ONLY valid
writer. Manual writes are blocked by `scripts/write-guard.sh` (`PreToolUse Write` hook)
and rejected by schema validation in `scripts/task-completed-verify.sh`.
**Readers**: `scripts/task-completed-verify.sh` (schema validation + freshness check),
`scripts/final-verification-evidence.sh` (F1-F4 completeness check), `evidence_read`
MCP tool
**Lifecycle**:
1. Created (or appended to) by each `evidence_log(...)` call.
2. Entries accumulate for the session; the file is NOT reset between tasks.
3. `task-completed-verify.sh` checks mtime freshness (≤300s) and validates schema.
4. `final-verification-evidence.sh` checks for all four F1-F4 entries scoped to
   `plan_sha256` at session Stop.
5. NOT cleared by `mode_clear(mode="all")` — evidence is a permanent audit trail.
   Cleared only by `mode_clear(mode="evidence")`.
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
| `entries[].plan_sha256` | string | (optional) SHA-256 of plan file; required on F1-F4 entries |

**Type enum**:

| Value | Meaning |
|---|---|
| `build` | Compilation or build command |
| `test` | Test suite run |
| `lint` | Linter or static-analysis run |
| `manual` | Manual verification step |
| `final_verification_f1` | Plan compliance review (oracle APPROVE/REJECT) |
| `final_verification_f2` | Code quality review |
| `final_verification_f3` | Manual QA |
| `final_verification_f4` | Scope fidelity check |

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
      "type": "final_verification_f1",
      "command": "oracle: APPROVE",
      "exit_code": 0,
      "output_snippet": "plan_sha256:ad649112c6e13e3d7984a3b4ffed9c3551baf0edfdc3516dc3b573cd81b20a9d verdict:APPROVE",
      "timestamp": "2026-05-10T12:10:00Z",
      "plan_sha256": "ad649112c6e13e3d7984a3b4ffed9c3551baf0edfdc3516dc3b573cd81b20a9d"
    }
  ]
}
```

**Dual-shape convention for F1-F4**: `plan_sha256` must appear BOTH as a first-class
field (`.plan_sha256`) AND embedded in `output_snippet` as `"plan_sha256:<hex>"`.
`final-verification-evidence.sh` checks both shapes; the first-class field is preferred
(structured access); the snippet embedding provides grep-ability.

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
3. File is NOT cleared automatically; cleared by `mode_clear(mode="all")` or manually.
4. Introduced in Phase 1 (commit 23b3d90) to fix the keyword echo loop bug (C-10).

**Top-level structure**: a plain object keyed by mode name. Each value is a mode-entry
object.

**Fields**:

| Field | Type | Description |
|---|---|---|
| `<mode_name>` | object | One key per detected mode (see modes below) |
| `<mode_name>.detected_at` | integer | Unix epoch when mode was first detected |
| `<mode_name>.session_id` | string | `CLAUDE_SESSION_ID` at detection time |

**Known mode keys**: `ralph`, `ultrawork`, `stop-continuation`, `cancel`, `handoff`,
`omca-setup`, `metis`, `plan`, `hephaestus`.

**Example**:
```json
{
  "ralph": {
    "detected_at": 1746878400,
    "session_id": "sess-001"
  },
  "handoff": {
    "detected_at": 1746878500,
    "session_id": "sess-001"
  }
}
```

**Note**: `subagent-start.sh` reads this file indirectly via `mode_is_active` from
`common.sh`, which checks only `ralph` and `ultrawork` keys for mode-active banners in
subagent context injection.

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
3. `session-init.sh` runs a one-time migration (commit 874738c): merges any legacy
   `"Task:delegate_error"` key into `"Agent:delegate_error"` (pre-v2.0, `tool_name`
   defaulted to `"Task"` instead of `"Agent"`). Guard: only fires if the file exists
   AND contains `"Task:delegate_error"` — idempotent on clean installs.
4. Values are cumulative integers — NOT reset each session.

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

## agent-usage.json

**Path**: `.omca/state/agent-usage.json`
**Writers**: `scripts/session-init.sh` (initializes/resets), `scripts/track-subagent-spawn.sh`
(sets `agentUsed = true`), `scripts/agent-usage-reminder.sh` (increments `toolCallCount`)
**Readers**: `scripts/agent-usage-reminder.sh`
**Lifecycle**:
1. Reset to `{"agentUsed": false, "toolCallCount": 0}` on every `SessionStart` by
   `session-init.sh`.
2. `track-subagent-spawn.sh` sets `agentUsed = true` whenever an Agent tool call fires.
3. `agent-usage-reminder.sh` increments `toolCallCount` on each direct tool call (when
   no agents are active). Emits a delegation reminder every 3rd call if `agentUsed` is
   still `false`.
4. Once `agentUsed = true`, `agent-usage-reminder.sh` exits 0 immediately without
   incrementing.

**Fields**:

| Field | Type | Description |
|---|---|---|
| `agentUsed` | boolean | True once any Agent tool call has fired this session |
| `toolCallCount` | integer | Number of direct (non-delegated) tool calls since session start |

**Example**:
```json
{
  "agentUsed": false,
  "toolCallCount": 6
}
```

---

## Cross-cutting invariants

### Agent ID identity
`subagents.json active[].id` and `active-agents.json [].id` refer to the same platform
`agent_id` value. During the spawn race window (between `PreToolUse` and `SubagentStart`),
`subagents.json` holds a synthetic `spawn-*` ID while `active-agents.json` does not yet
have an entry. After the `SubagentStart` bridge in `subagent-start.sh`, both files
converge on the platform ID. Always union both ID sets to get a complete running-agent
count.

### plan_sha256 linkage
`pending-final-verify.json .plan_sha256` must match the `plan_sha256` on F1-F4 entries in
`verification-evidence.json`. `final-verification-evidence.sh` accepts the SHA from either
the first-class `.plan_sha256` field or the embedded `"plan_sha256:<hex>"` substring in
`.output_snippet`. Callers should write both shapes (dual-shape convention).

### Session ID staleness
`pending-final-verify.json` and `active-modes.json` both store `session_id` to enable
cross-session staleness detection. `session-init.sh` sweeps `pending-final-verify.json`
on startup; `keyword-detector.sh` uses `active-modes.json` session check to suppress
re-announcements from the same session only.

### Atomic writes
All state files are written atomically: `tmp=$(mktemp) && jq ... > "$tmp" && mv "$tmp"
target.json`. Never write to state files directly; use the designated MCP tools or hook
scripts. `verification-evidence.json` additionally rejects direct writes via the
`write-guard.sh` PreToolUse hook.
