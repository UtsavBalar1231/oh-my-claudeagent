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
- `statusline/core.py` — reads `boulder.json` directly (Python, so no shim needed)
  and resolves it via `_boulder_core.resolve_bound_plan(..., strict=True)`, the same
  strict call every hook-script consumer makes. The TODO token renders only when
  the payload's `session_id` has an explicit `bindings[]` entry and the bound plan
  still has open tasks. Sole-plan / most-recent fallbacks and flat-schema files
  never display — those fallbacks are resume plumbing for hooks, and honoring them
  in the statusline made fresh sessions inherit stale plans.
- `scripts/session-init.sh` — also invokes the `boulder_gc.py` shim (write path,
  under lock) before resolving; see GC policy layer 2 below.
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

**Resolution — `resolve_bound_plan(data, session_id, strict=False)` (in
`servers/tools/_boulder_core.py`)**:

Pure-read function, called by every reader above (directly in Python, or via the
`boulder_resolve.py` shim from bash). It never writes.

Lenient ladder (`strict=False`, the default), in order:
1. This session has an explicit `bindings[session_id]` whose `plan_name` still exists
   in `plans` → return that plan.
2. Exactly one plan is registered → return it (single-plan case needs no binding).
3. Multiple plans, no binding for this session → return the plan with the most recent
   `started_at`.
4. No plans registered → `{}`.

Strict mode (`strict=True`) stops after step 1: only an explicit binding resolves a
plan; steps 2-3 are skipped and an unbound session gets `{}`. Fallback steps 2-3 are
resume plumbing for readers that tolerate ambiguity: the only lenient consumer is the
`boulder_progress` MCP tool (direct `plan_name` lookups still bypass the resolver
ladder entirely). Every hook-script consumer that enforces or injects on the session's
behalf passes `strict=True` so an unbound session can never inherit another session's
plan: `plan-continuation-guard.sh`, `final-verification-evidence.sh`,
`subagent-start.sh`, `session-init.sh`, `pre-compact.sh`, and `statusline/core.py`
(see the Readers note above) — the statusline's TODO counter calls through the
same strict resolver rather than a separate in-process check.

**`boulder_resolve.py`** (`servers/tools/boulder_resolve.py`) is a stdlib-only,
bash-callable wrapper around `resolve_bound_plan`: `python3 boulder_resolve.py
[session_id] [working_directory] [--strict]`, prints the resolved `{plan_name,
active_plan, worktree_path}` triple as JSON (or `{}`) and always exits 0 — bash readers
should shell out to this shim rather than hand-parsing `boulder.json`, so every reader
stays on the exact same resolution ladder as the Python writer. `--strict` (any
position in argv) forwards `strict=True`.

**Completion is derived, not stored**. There is no `completed_at` field — a plan's
completion is computed on demand from its own `- [ ] N.` / `- [x] N.` checkboxes
(`plan_is_complete` + `CHECKBOX_RE` in `_boulder_core.py`, the single source shared
by `boulder.py`, `boulder_gc.py`, and `statusline/core.py`). A plan with no
checkboxes at all is never considered complete.

**GC policy** — three layers:
1. **Primary, at `SessionEnd`**: `scripts/session-cleanup.sh` deletes this session's
   `bindings[session_id]` entry under an exclusive `flock` on a *separate* lock file,
   `.omca/state/boulder.json.lock` — the same lock file `boulder.py` uses for its
   read-modify-write, so the two writers never race. Runs only when the end reason is
   not `"resume"`. Never deletes `plans` entries.

   **This layer is not guaranteed to run to completion.** The platform's `SessionEnd` budget
   is 1.5 seconds, and it is raised only by a per-hook `timeout` found in a *settings file*;
   a `timeout` declared in a plugin-provided `hooks.json` never raises it. So
   `session-cleanup.sh` can be killed mid-write, leaving this session's binding in place, and
   recovery falls to layer 2 on the next `SessionStart`. The handler's `"timeout": 5` is a
   five-second *cap*, not a budget raise: raising that number does not extend the budget and
   does not fix the leak. The only lever is the user-side
   `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` env var (milliseconds). A related hazard from the
   same window applied to `SessionStart`, not `SessionEnd`: hook events did not stream during
   `SessionStart` hooks in headless sessions, so a remote worker could be idle-reaped mid-hook
   and leave `session-init.sh`'s state resets half applied. Fixed in v2.1.204.

   A second correctness trap on this layer: a forked session's `SessionStart` used to wipe the
   live parent's per-subagent model map, dedup map, and counters, and overwrite the shared
   session file so the parent's `SessionEnd` deleted the wrong binding. `session-init.sh` now
   branches on the payload's `source`. Per the docs' `SessionStart` matcher table, `"fork"`
   covers `--fork-session` with `--resume` or `--continue`, the `/fork` background copy, and
   `/branch`; a plain background dispatch is not automatically `"startup"`, and before
   v2.1.214 forks reported `"resume"`. Only `"fork"` skips the shared-state resets and the
   `session.json` write; `startup`, `resume`, `clear`, and `compact` still own the full reset,
   because each is either the same session continuing or a new session with no concurrent
   peer. `session-cleanup.sh` prefers the payload's own `session_id` when pruning a binding,
   with the session-file fallback retained for payloads that carry no id, and it skips the
   shared-file deletions and directory sweeps entirely when `session.json` records a different
   session id, so an ending fork cannot strip a live parent's state.
2. **Self-heal, at `SessionStart`**: `scripts/session-init.sh` runs the stdlib-only
   `boulder_gc.py` shim (`gc_prune_unbound()` in `_boulder_core.py`) under the same
   lock. It drops bindings that reference nonexistent plans, then prunes any plan
   that is simultaneously unbound AND (checkbox-complete, missing its plan file, or
   lacking an `active_plan` path) — no age threshold. This is what clears a
   finished-but-never-cleared plan before it can leak into session titles or
   resolver fallbacks. Incomplete plans with a live file are always kept (resumable
   work). A flat-schema file is only rewritten (in registry shape) when the GC
   actually pruned something; untouched flat files stay as-is for `boulder_write`'s
   lazy migration.
3. **Backstop, on every `boulder_write`**: `_gc_prune()` in `boulder.py` prunes (a) any
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

**Session ID note**: the platform session UUID (the transcript filename, e.g.
`a457c5cc-5014-...`) is the canonical id — it is what every session-id-keyed
lookup must agree on, including `bindings{}` keys written by `boulder_write`.

`_resolve_session_id` (Python/MCP side, `servers/tools/_common.py`) reads the
`CLAUDE_CODE_SESSION_ID` env var, confirmed live-present in MCP/agent shell env
and equal to the platform UUID. The bash-side `resolve_session_id`
(`scripts/lib/common.sh`) checks a differently-named env var (`CLAUDE_SESSION_ID`)
first — confirmed ABSENT from hook shell env in practice — then falls back to the
hook payload's `.session_id` (present and equal to the platform UUID on every
`SessionStart` call), then `session.json`'s `.sessionId`. Because tier 1 is dead
in practice, the bash resolver effectively always lands on tier 2, which does
carry the platform UUID.

`scripts/session-init.sh` used to hand-roll its own id lookup
(`${CLAUDE_SESSION_ID:-$(date +%s)-$$}`), skipping the payload's `.session_id`
entirely and writing an epoch-PID id into `session.json` and the SessionStart
banner. That epoch-PID id never matched `boulder_write`'s platform-UUID
bindings key, so anything resolving a session's bound plan from a banner-derived
id (e.g. the statusline `T:` counter) silently found nothing. Fixed by having
`session-init.sh` call the shared `resolve_session_id()` helper instead, so it
lands on the same platform UUID as every other reader.

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
**Writers**: all five `*-error-recovery.sh` / `delegate-retry.sh` scripts, via
the shared `error_count_bump(key, error_summary)` helper in `scripts/lib/common.sh`
(`PostToolUseFailure` hooks for Agent, Edit, Bash, Read, and the catch-all JSON
error path). Each script bumps the counter only on branches that actually emit
PostToolUseFailure advice, not on silent/deferred exit-0 branches.
**Readers**: the same five scripts (circuit breaker at 3+ errors); `scripts/session-init.sh`
(one-time legacy-key migration on session start)
**Lifecycle**:
1. Created on first error encounter; updated atomically per error event
   (mktemp+mv) via `error_count_bump`.
2. Key format: `"<tool_name>:<error_kind>"` where `tool_name` comes from
   `.tool_name // "Agent"` (or `// "Edit"` etc.) in the hook payload.
3. Values are NOT reset each session, except for a decay window: a key's
   `count`/`last_errors` reset to empty when the prior `last_failure_at` is
   older than `ERROR_COUNT_DECAY_SECONDS` (300s / 5min, `common.sh`) — a clean
   window this long means the failure streak is over, not permanently tripped.
4. `session-init.sh` runs a one-time, shape-agnostic migration of the legacy
   `Task:delegate_error` key into `Agent:delegate_error` on every session start
   (idempotent — only fires when the legacy key is present).

**Fields** (the schema is an open object; known keys are below):

| Key | Type | Description |
|---|---|---|
| `"Agent:delegate_error"` | int or object | Delegation failures via the Agent tool |
| `"Edit:edit_error"` | int or object | Edit tool failures |
| `"Bash:bash_error"` | int or object | Bash tool failures (from `bash-error-recovery.sh`) |
| `"Read:read_error"` | int or object | Read tool failures (from `read-error-recovery.sh`) |
| `"<tool>:json_error"` | int or object | JSON/tool-output parse failures (from `json-error-recovery.sh`) |
| `"<tool>:<kind>"` | int or object | General pattern; any tool name and error kind |

Each value is EITHER a bare integer (legacy shape, pre-`error_count_bump`) OR
an object `{count, last_failure_at, last_errors}`:

| Object field | Type | Description |
|---|---|---|
| `count` | integer | Cumulative failures since the last decay reset |
| `last_failure_at` | integer (epoch seconds) | Timestamp of the most recent bump |
| `last_errors` | array of string | Most recent error summaries, newest first, capped at 3, each truncated to 160 chars with newlines stripped |

`error_count_bump` upgrades a bare-int legacy value to the object shape
in-memory on read (`{count: N, last_failure_at: null, last_errors: []}`); it is
never persisted back to disk in the bare-int shape once bumped.

**Example**:
```json
{
  "Agent:delegate_error": {
    "count": 2,
    "last_failure_at": 1746878400,
    "last_errors": ["MCP server 'plugin:...' not connected", "timeout after 30s"]
  },
  "Edit:edit_error": 1
}
```

**Circuit breaker**: once any key's count reaches ≥ 3, the corresponding
recovery script appends a hard-stop instruction plus an "Attempts: 1) <err> 2)
<err> 3) <err>" timeline (built from `last_errors // [] | reverse`, oldest
first) to the context: "Stop retrying the same approach. Escalate to oracle."

---

## subagent-models.json

**Path**: `.omca/state/subagent-models.json`
**Writers**: `scripts/subagent-start.sh` (`SubagentStart` hook),
`scripts/subagent-stop.sh` (`SubagentStop` hook)
**Readers**: statusline renderer (per-subagent model names, and
`_active_agent_count()` renders `N agents` on Line 1 from `len()` of this file)
**Lifecycle**:
1. Upserted on every `SubagentStart` event that carries a non-empty `agent_id`.
2. The entry is deleted on that agent's `SubagentStop` — required because the
   main statusline counts entries as "active agents"; without the delete the
   count is "agents ever spawned this session", not "running now".
3. Reset to `{}` by `scripts/session-init.sh` on `SessionStart` (session-scoped,
   mirrors the `injected-context-dirs.json` reset) — the backstop for entries a
   crashed subagent leaves behind.

**Top-level structure**: a plain object keyed by `agent_id` (unique per spawned
subagent instance).

**Fields**:

| Field | Type | Description |
|---|---|---|
| `<agent_id>.agent_type` | string | Raw `agent_type` from the SubagentStart payload (e.g. `oh-my-claudeagent:executor`) |
| `<agent_id>.model` | string | Friendly display name resolved from the agent's frontmatter `model:` field, or `""` if unresolvable |

**Model resolution**: strip the `oh-my-claudeagent:` prefix from `agent_type`,
read `${CLAUDE_PLUGIN_ROOT}/agents/<name>.md` frontmatter `model:`, map via a
small case statement. Tier aliases are what agent frontmatter declares, so those are the
live arms: `opus`→`Opus`, `sonnet`→`Sonnet`, `fable`→`Fable`,
`haiku`→`Haiku`. Full ids stay as arms only for frontmatter compatibility, in case an agent
file pins a generation again; the hook never reads the spawning call:
`claude-fable-5`→`Fable 5`, `claude-opus-5`→`Opus 5`,
`claude-opus-4-8`→`Opus 4.8`, `claude-sonnet-5`→`Sonnet 5`,
`claude-haiku-4-5`→`Haiku 4.5`. An empty `model:` maps to `""`; anything else falls
through to the raw value. Non-OMCA
agent types (e.g. `explore`, `general-purpose`) have no matching frontmatter
file, so `model` is stored as `""` and the renderer shows no model.

This field records the *frontmatter* model, not the effective one. Before v2.1.211 a
subagent model override was reverted on resume, so the two could diverge; that divergence is
exactly why `statusline/subagent.py` prefers the payload's own model field over this file
when both are present.

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

## plan-continuation.json

**Path**: `.omca/state/plan-continuation.json`
**Writers**: `scripts/plan-continuation-guard.sh` (`Stop` hook)
**Readers**: `scripts/plan-continuation-guard.sh` (own counters, read back on
the next Stop event)
**Lifecycle**:
1. Read (via `jq_read`, which returns the field's `//` default on a missing
   file) at the start of every Stop event once the guard's earlier rails (kill
   switch, no bound plan, no unchecked boxes, user-pause, compaction, stale
   binding, assistant-question) have all passed.
2. Written only when the guard is about to block (`exit 2`) or about to
   persist a stagnation escape — never on a rail that exits before the
   counter section.
3. Reset (deleted) by `scripts/session-init.sh` on every `SessionStart` —
   counters are session-scoped; a new session gets a clean cooldown/hard-cap
   state regardless of the prior session's history.

**Fields**:

| Field | Type | Description |
|---|---|---|
| `consecutive_blocks` | integer | Consecutive Stop events this guard has blocked without an intervening clean window |
| `last_block_at` | integer (epoch seconds) | Timestamp of the most recent block, used for both the exponential cooldown and the hard-cap clean-window reset |
| `last_unchecked_count` | integer | The plan's unchecked-checkbox count as of the last block, compared against the current count to detect stagnation |
| `same_count_run` | integer | Consecutive blocks where `last_unchecked_count` did not change — a run length, not a boolean, so the guard can tell "matched once" from "matched `STAGNATION_STREAK` times in a row" |
| `stagnated` | boolean | Once `true`, the guard exits open (no more blocks) for the rest of the session — set when `same_count_run` reaches `STAGNATION_STREAK` (3) |

**Example**:
```json
{
  "consecutive_blocks": 2,
  "last_block_at": 1746878400,
  "last_unchecked_count": 4,
  "same_count_run": 1,
  "stagnated": false
}
```

**Backoff mechanics**: cooldown is `BASE_COOLDOWN_SECONDS * 2^consecutive_blocks`
(5s, 10s, 20s, 40s, 80s); once `consecutive_blocks` reaches `HARD_CAP_BLOCKS` (5)
the guard stops blocking entirely until `CLEAN_WINDOW_SECONDS` (300s) pass
since `last_block_at`, at which point `consecutive_blocks` resets to 0.

---

## tool-loop-window.json

**Path**: `.omca/state/tool-loop-window.json`
**Writers**: `scripts/tool-loop-detector.sh` (`PostToolUse Bash|Edit|Read|Grep|Glob` hook)
**Readers**: `scripts/tool-loop-detector.sh` (own signature/count, read back on
the next matching tool call)
**Lifecycle**:
1. Written on every matching `PostToolUse` call — this is a sliding one-slot
   window, not a session-wide log, so it is overwritten (not appended) each call.
2. Not explicitly reset by `scripts/session-init.sh`; deleted at `SessionStart`
   alongside the other two new state files for consistency (a stale signature
   from a prior session would otherwise let a false "3rd repeat" fire on the
   first call of a new session).

**Fields**:

| Field | Type | Description |
|---|---|---|
| `signature` | string | First 16 hex chars of `sha256(canonicalized {tool_name, tool_input})` — `jq -cS` sorts object keys so key-order differences never desync the signature |
| `count` | integer | Consecutive calls sharing this exact signature and `prompt_id`; resets to 1 when either changes |
| `prompt_id` | string | UUID of the user prompt in flight when the slot was written. Empty string when the client predates v2.1.196 or no user input has happened yet |

**Example**:
```json
{
  "signature": "a1b2c3d4e5f6a7b8",
  "count": 2,
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Fire condition**: when `count` reaches `LOOP_FIRE_COUNT` (3), the hook emits
a `PostToolUse` `additionalContext` nudge exactly once for that streak (not on
every call after the 3rd) — the counter keeps incrementing past 3 but the
emit is gated on `count == 3` specifically.

The count resets to 1 when EITHER `signature` OR `prompt_id` changes, so a repeat carried
across a user turn boundary no longer reads as the 3rd call of a streak. State files written
by older versions carry no `prompt_id` and compare equal to an absent field, so there is
nothing to migrate.

**Known scoping gap**: this is a single global slot shared by the main session and every
concurrent subagent. Interleaved subagent calls can shred a real streak (false negative),
and less often three unrelated agents issuing the same call can trip the nudge (false
positive). The correct scoping key is `agent_id`, not `prompt_id`; `prompt_id` only fixes
the turn-boundary case. Fixing it properly means either keying the state file per
`agent_id` or moving to a small keyed map with GC on `SubagentStop`, which is a decision,
not a patch. Tracked in `docs/reference/known-issues.md`.

---

## delegation-counter.json

**Path**: `.omca/state/delegation-counter.json`
**Writers**: `scripts/delegation-reminder.sh` (`PostToolUse Edit|Write|Bash` and
`PostToolUse Agent` hooks — both matchers point at the same script; behavior
branches on `.tool_name`)
**Readers**: `scripts/delegation-reminder.sh` (own counters, read back on the
next direct work-tool call)
**Lifecycle**:
1. Only evaluated for main-session calls — the script exits 0 immediately when
   `.subagent_type` is present in the payload (a subagent's own tool calls
   never count toward or reset this counter).
2. Incremented on each direct `Edit`/`Write`/`Bash` call while `silenced` is
   `false`; reset to `{direct_calls: 0, silenced: true}` whenever an `Agent`
   call is observed (a delegation happened) — this also permanently silences
   the reminder for the rest of the session, matching the header comment's
   "fires at most once per session, not per batch" contract.
3. Once `direct_calls` reaches 3 with no intervening delegation, the script
   fires the one-shot reminder and sets `silenced: true`.
4. `silenced: true` is terminal for the session: no `Agent` call or further
   direct call ever flips it back to `false`. The next flip only happens via
   the `SessionStart` reset below.
5. Reset (deleted) by `scripts/session-init.sh` on every `SessionStart` —
   the nudge is session-scoped, not a persistent judgment across sessions.

**Fields**:

| Field | Type | Description |
|---|---|---|
| `direct_calls` | integer | Consecutive direct work-tool calls (Edit/Write/Bash) since session start, while `silenced` is `false` |
| `silenced` | boolean | `true` once the one-shot reminder fires OR any `Agent` call is observed — terminal for the rest of the session (see lifecycle) |

**Example**:
```json
{
  "direct_calls": 3,
  "silenced": true
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

### Platform transcript layout (read-only, not OMCA state)

`session_search` reads the platform's own transcript tree under
`~/.claude/projects/<slug>/`, which is not an OMCA-owned schema and must never be written
to. Two layout facts the tool depends on:

- A large tool result is spilled to `<slug>/<session>/tool-results/*.txt` and only a
  preview stays inline in the `.jsonl`, so a flat `*.jsonl` glob under-reports. The sidecar
  is searched under role `tool`, with its timestamp synthesized from file mtime since the
  file carries none.
- `<slug>/<session>/subagents/` holds subagent turns and is deliberately out of scope: a
  subagent's own turns surface as its parent's tool result, so including them would
  double-count the same text.
