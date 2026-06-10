# OMCA Sync Audit — Claude Code v2.1.141 → v2.1.167

**Type**: Single source of truth for the v2.1.141–v2.1.167 platform sync implementation.
**Scope**: Full-surface alignment across hooks/scripts, skills, agents, statusline, MCP servers, plugin.json, and all OMCA documentation surfaces. Also fixes two session-discovered dogfooding bugs (Bug A, Bug B).
**Baseline correction**: Previous OMCA sync was v2.1.140 per CHANGELOG.md:143 (plugin was at v2.4.0/v2.5.2). User believed prior baseline was v2.1.136 — confirmed as v2.1.140 via CHANGELOG.
**Status**: All 18 non-final tasks complete. Phase D tasks 16-18 verified; task 19 (CHANGELOG + version bump + cache rebuild) is next.
**Compiled**: 2026-06-06.

---

## Implementation summary

| Surface | Items | Status |
|---|---|---|
| Hooks (H1-H8) | 8 | All resolved — 2 ADOPTED, 1 DOCUMENT-only, 1 validator-array, 4 NO-OP/VERIFY |
| Skills (S1-S5) | 5 | 1 ADOPTED partial, 4 NO-OP/DOCUMENT/VERIFY |
| Agents (A1-A5) | 5 | 1 VERIFY CLEAN (10/10), 1 DOCUMENTED, 3 SKIP/NO-OP |
| Plugin.json (P1-P4) | 4 | 1 ADOPTED, 1 SKIP, 2 DOCUMENT |
| Statusline (T1-T3) | 3 | All 3 ADOPTED — +34 pytest cases |
| MCP (M1-M3) | 3 | 1 ADOPTED, 1 NO-OP, 1 DOCUMENT |
| Config/Env (C1-C5) | 5 | All 5 DOCUMENT (C3 zero refs = grounding-NO-OP) |
| Output Styles (O1-O2) | 2 | 1 VERIFY VALID, 1 DOCUMENT |
| Bug A | — | ADOPTED — vector 1 live-verified, vector 2 deferred |
| Bug B | — | ADOPTED — DEFECT-PROVEN, fix implemented + 28/28 bats |

**Total disposition rows covered**: 36/36.

---

## Per-surface findings

### Hooks surface (H1–H8)

#### H1 — Stop-block cap + `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (v2.1.143) — ADOPTED

**Finding**: ralph-persistence.sh had no cap guard on the counter-less INCOMPLETE>0 block path and the boulder-fallback mtime block paths. At the platform cap of 8 consecutive Stop-blocks, claude-code would force-stop regardless; OMCA had no graceful yield.

**Implementation**:
- New `STOP_BLOCK_CAP="${CLAUDE_CODE_STOP_HOOK_BLOCK_CAP:-8}"` at script top; env-overridable.
- New `ralph-cap-state.json` state file in `.omca/state/` (atomic tmp+mv writes). Separate from `ralph-state.json` so the boulder-fallback path (runs without ralph-state.json) is also protected.
- `boulder_block_count` counter guards both counter-less boulder paths; resets on plan-hash change or completed-count increase (genuine progress).
- `incomplete_block_count` counter guards the INCOMPLETE>0 ralph path; resets when `STAGNATION==0` (task-hash changed).
- At cap−1 no-progress blocks, emits allow-stop (exit 0, no `decision` key) with `reason: "Yielding to platform. To resume: invoke /oh-my-claudeagent:ralph again."`.

**Evidence**: `evidence_log type=test, 2026-06-06T09:32:11Z` — validate-plugin.sh 160/0/1 + ralph_persistence.bats 17/17 (14 pre-existing + 3 new: H1a cap-yield, H1b progress-reset, H2 background_tasks no-op). Independent orchestrator re-verification at `2026-06-06T09:33:49Z`.

**Files modified**: `scripts/ralph-persistence.sh`, `tests/bats/hooks/ralph_persistence.bats`

#### H2 — Stop/SubagentStop inputs `background_tasks`, `session_crons` (v2.1.145) — verified NO-OP (orthogonal)

**Finding**: The new `background_tasks`/`session_crons` Stop payload fields are orthogonal to OMCA's ralph decision. When ralph is NOT active, the script already exits 0 (allows stop). When ralph IS active, the block/allow decision is based solely on ralph state (INCOMPLETE count, stagnation, boulder). Background tasks do not factor in. No code change required.

**Evidence**: `evidence_log type=test, 2026-06-06T09:32:11Z` — bats test 17 (H2 background_tasks no-op: payload with both fields present, existing blocking assertions unmodified).

#### H3 — Stop/SubagentStop `hookSpecificOutput.additionalContext` output (v2.1.163) — DOCUMENT-ONLY (grounding-inconclusive)

**Finding**: Grounding evidence (task 1) established that the v2.1.163 hooks schema treats `decision:block` and `hookSpecificOutput.additionalContext` as SEPARATE output patterns — co-existence not documented (INCONCLUSIVE). Additionally, the exit-2 path (used by final-verification-evidence.sh) cannot carry additionalContext: platform docs state "Claude Code only processes JSON on exit 0. If you exit 2, any JSON is ignored."

**Decision**: DOCUMENT-ONLY per plan default and grounding contract. ralph-persistence.sh (stdout `{"decision":"block","reason":...}`) and final-verification-evidence.sh (stderr + exit 2) both keep their existing emission shapes unchanged.

**Opportunistic fix skipped**: stale `evidence.jsonl` string at final-verification-evidence.sh:315 (canonical file is `verification-evidence.json`) — condition was "fix only if this file is edited anyway"; file was NOT edited this sync. Listed as known-cosmetic in deferred items.

**Evidence**: `evidence_log type=manual, 2026-06-06T09:23:04Z` (WebFetch hooks schema probe). `evidence_log type=manual, 2026-06-06T09:33:54Z` (task 4 resolution record).

#### H4 — SessionStart output `sessionTitle` (v2.1.152) — ADOPTED

**Finding**: OMCA session-init.sh had no `sessionTitle` emission. New field allows setting the Claude Code window/tab title, improving multi-session discoverability when running plans.

**Implementation**: Added boulder.json read at end of session-init.sh. When `plan_name` is present, emits `sessionTitle: "OMCA: <plan_name>"` composed into the existing `hookSpecificOutput` envelope. No-boulder path uses the unchanged `echo` path. All composition with `additionalContext` and `hookEventName` preserved.

**Evidence**: `evidence_log type=test, 2026-06-06T09:50:43Z` — session_lifecycle.bats 12/12 (9 pre-existing + 3 new: boulder-present→sessionTitle correct; no-boulder→key absent; additionalContext still present with boulder active).

**Files modified**: `scripts/session-init.sh`, `tests/bats/hooks/session_lifecycle.bats`

#### H5 — SessionStart output `reloadSkills` (v2.1.152) — DOCUMENT

**Finding**: New `reloadSkills` boolean output on SessionStart causes Claude Code to reload skill definitions mid-session. OMCA does not need to emit this (skills load correctly on session start). Documented in OMCA.md hooks section for awareness.

**Evidence**: Documented in OMCA.md as part of task 16. No code change, no standalone evidence entry (documentation-only row per plan convention).

#### H6 — New platform events: Elicitation, ElicitationResult, MessageDisplay, PostToolBatch, Setup (v2.1.152+) — validator-aware (DOCUMENT + array addition)

**Finding**: Five new hook events appeared in the v2.1.141-v2.1.167 window. OMCA must NOT register handlers for these events (binding Must-NOT-adopt list). However, the validate-plugin.sh validator needed to know about them to report skip (not failure) when they are absent from hooks.json.

**Implementation**: Added a new third array `new_platform_events` in validate-plugin.sh (separate from `latest_lifecycle_events` and `post_cutover_events`). Entries in this array get skip semantics: validator reports skip when handler absent, pass when present. Placement in `post_cutover_events` would have caused 5 failures (HARD_CUTOVER_ACTIVE=1 + events absent from hooks.json). Baseline preserved: 160 passed, 0 failed, 6 skipped (was 160/0/1; 5 new skips for the 5 unregistered events).

**Evidence**: `evidence_log type=test, 2026-06-06T09:36:09Z` (executor) + `2026-06-06T09:36:59Z` (orchestrator independent verification — confirmed new_platform_events array at validate-plugin.sh:179-185 with 5 entries alphabetical).

**Files modified**: `scripts/validate-plugin.sh`

#### H7 — Hook terminal access loss / `terminalSequence` (v2.1.141) — verified NO-OP

**Finding**: v2.1.141 removed terminal stdout access from hooks. Grep audit of all OMCA hook scripts confirmed: `notify.sh` uses only desktop notification APIs (terminal-notifier/osascript/notify-send/zenity/powershell) and stderr bell — zero `/dev/tty` or `tput` writes. No OMCA hook script writes to terminal stdout. The hook-stdout-to-terminal loss does not affect OMCA.

**Evidence**: `evidence_log type=manual, 2026-06-06T09:22:25Z` (grep audit of scripts/).

#### H8 — `if:` condition matching semantics (v2.1.163) — verified NO-OP

**Finding**: v2.1.163 clarified that `if:` conditions are constrained to command name matching only (subshell/backtick patterns excluded). Audit of all 12 OMCA `if:` clauses in hooks.json confirmed: all are simple command-name-only globs (Bash(rm *), Bash(npm *), Bash(jq *), etc.). None constrain past the command name; none use subshell/backtick patterns. No code change needed.

**Evidence**: `evidence_log type=manual, 2026-06-06T09:22:29Z` (clause extraction + validate-plugin.sh 161/0/1).

---

### Skills surface (S1–S5)

#### S1 — Skill `disallowed-tools` frontmatter (v2.1.152) — ADOPTED partial (github-triage + hephaestus; metis/momus justified-skip)

**Finding**: New `disallowed-tools` frontmatter key allows skills to restrict which tools they can call. Audit identified two clearly-safe candidates and two grounding-gated candidates.

**Implementation**:
- `skills/github-triage/SKILL.md`: added `disallowed-tools: [Write, Edit]`. Justification: orchestrator skill is read-only; report writing is done by spawned executor subagents in separate tool context. Denying these enforces the read-only-orchestrator contract.
- `skills/hephaestus/SKILL.md`: added `disallowed-tools: [Agent]`. Justification: forked specialist must not delegate; fix loop is solo (reproduce → diagnose → patch → verify).
- **Metis/momus justified-skip**: both skills use `context: fork` + `agent:` binding. The fork context means the skill body runs INSIDE the named agent (metis/momus), which already carries `disallowedTools: [Bash, Agent]` at the agent-config layer. Skill-level disallowed-tools would be redundant. Grep confirmed zero Bash/shell usage in both SKILL.md bodies.

**Evidence**: `evidence_log type=manual, 2026-06-06T09:50:59Z` (grep proof + YAML parse confirmation for both files; metis/momus grounding rationale). Consolidated validator run at `2026-06-06T09:55:14Z`.

**Files modified**: `skills/github-triage/SKILL.md`, `skills/hephaestus/SKILL.md`

#### S2 — `\$` escape for literal `$` before digit (v2.1.163) — verified NO-OP

**Finding**: v2.1.163 requires `\$` to produce a literal `$` before a digit. Grep of all `commands/` and `skills/` bodies for `\$[0-9]` patterns returned zero matches. No OMCA file contains literal dollar-digit sequences.

**Evidence**: `evidence_log type=manual, 2026-06-06T09:22:34Z`.

#### S3 — `workflow` → `ultracode` keyword rename (v2.1.157) — verified NO-OP

**Finding**: CC v2.1.157 renamed the platform keyword trigger `workflow` to `ultracode`. OMCA uses `ultrawork` (distinct name, unrelated). Grep of docs/, skills/, agents/, commands/, output-styles/ for `workflow` with platform/keyword/trigger context returned zero matches. `marketplace.json` uses `workflow` only as a category tag.

**Evidence**: `evidence_log type=manual, 2026-06-06T09:22:38Z`.

#### S4 — `/reload-skills` command (v2.1.152) — DOCUMENT

**Finding**: New `/reload-skills` command picks up skill edits in an active session without restarting. Relevant for OMCA users editing orchestration-block.md mid-session. Documented in `skills/omca-setup/SKILL.md` install/update flow as part of task 17.

**Evidence**: Documented via task 17. `evidence_log type=manual, 2026-06-06T10:02:39Z`.

#### S5 — `context: fork` infinite-loop fix (v2.1.145) — VERIFY (context:fork skills exercised live)

**Finding**: v2.1.145 fixed an infinite-loop in `context: fork` skills. Metis, momus, and hephaestus all use `context: fork`. These skills were exercised live throughout planning and Phase A/B/C execution — metis and momus forks returned non-empty results in this session, confirming the fix is in effect and OMCA's fork-based skills work correctly.

**Evidence**: Exercised live during planning (metis/momus forks returned). No standalone evidence entry (not re-run as an isolated test per plan disposition).

---

### Agents surface (A1–A5)

#### A1 — Lean system prompt now default (v2.1.154) — VERIFY CLEAN (10/10 agents)

**Finding**: Audit of all 10 `agents/*.md` bodies against the v2.1.154 lean-system-prompt default. All 10 agents are CLEAN — no stale references to absent built-in prompt sections, no "as the system prompt says" references, no redundant override prose. Zero edits required.

**Agents audited**: executor, explore, librarian, hephaestus, metis, momus, multimodal-looker, oracle, prometheus, sisyphus.

**Evidence**: `evidence_log type=manual, 2026-06-06T09:51:18Z`.

#### A2 — `skills:` preload frontmatter on agents — SKIP (CHANGELOG non-adoption)

**Decision**: Deliberate non-adoption. Preloading skills increases context cost; OMCA agents discover skills via the Skill tool at the point of invocation. Recorded in OMCA.md deliberate non-adoptions table and will appear in CHANGELOG.

#### A3 — Plugin agents IGNORE `hooks`/`mcpServers`/`permissionMode` frontmatter — DOCUMENTED

**Finding**: Grep confirmed zero instances of `hooks`, `permissionMode`, or `mcpServers` in any `agents/*.md` frontmatter (all fields would be silently ignored for plugin-shipped agents). Added documentation note to OMCA.md agents section ("Plugin-agent frontmatter restrictions (v2.1.154+)") covering all three ignored fields and the workaround (copy to `.claude/agents/` or `~/.claude/agents/`).

**Evidence**: `evidence_log type=manual, 2026-06-06T09:51:18Z`.

**Files modified**: `docs/OMCA.md`

#### A4 — `Agent(type,...)` spawn-allowlist in `tools:` (v2.1.147) — SKIP → DOCUMENT

**Decision**: Only applies to main-thread agents; sisyphus needs full spawn capability. Recorded in OMCA.md deliberate non-adoptions table and CHANGELOG.

#### A5 — Inline agent `mcpServers` strict-mcp policies (v2.1.153) — verified NO-OP

**Finding**: Grep of all `agents/*.md` for `mcpServers` returned zero matches. No OMCA agent declares inline mcpServers. The v2.1.153 strict-mcp policy change does not affect OMCA.

**Evidence**: `evidence_log type=manual, 2026-06-06T09:22:43Z`.

---

### Plugin.json surface (P1–P4)

#### P1 — `displayName` in plugin.json (v2.1.143) — ADOPTED

**Finding**: New `displayName` field controls the human-readable name shown in the Claude Code plugin marketplace UI. OMCA's plugin.json lacked this field.

**Implementation**: Added `displayName: "Oh My ClaudeAgent"` to `.claude-plugin/plugin.json`. Version parity check (validate-plugin.sh:694-706, plugin.json == marketplace.json) continues to pass.

**Evidence**: Consolidated verification at `2026-06-06T09:55:14Z` — plugin.json displayName="Oh My ClaudeAgent", version 2.5.2 == marketplace.json 2.5.2.

**Files modified**: `.claude-plugin/plugin.json`

#### P2 — `defaultEnabled` in plugin.json (v2.1.154) — SKIP (CHANGELOG non-adoption)

**Decision**: OMCA is enabled on install; setting `defaultEnabled: false` would break the install-and-use workflow. Deliberate non-adoption recorded in OMCA.md and CHANGELOG.

#### P3 — Root-SKILL.md for single-skill plugins (v2.1.142) — DOCUMENT

**Finding**: v2.1.142 added support for a root-level SKILL.md for single-skill plugins. Not applicable to OMCA (multi-skill plugin). Documented in OMCA.md plugin.json section for completeness.

#### P4 — Plugin dependency enforcement (v2.1.143) — DOCUMENT

**Finding**: v2.1.143 added plugin dependency enforcement semantics. OMCA has no plugin dependencies. Documented in OMCA.md plugin.json section.

---

### Statusline surface (T1–T3)

#### T1 — `workspace.repo.*` + `pr.*` input fields (v2.1.145) — ADOPTED

**Finding**: New statusline payload fields `workspace.repo.{host,owner,name}` and `pr.{number,url,review_state}` enable a repo/PR segment in the status line.

**Implementation** (in `statusline/core.py`):
- Added `_compose_repo_pr(data, glyphs, nerd)` helper after the OSC 8 helpers section.
- Reads `workspace.repo.{host,owner,name}` and `pr.{number,url,review_state}`.
- Repo label: "owner/name" when owner present, else bare name. OSC 8 hyperlink when all three fields present.
- PR number shown as "#N", OSC 8-linked when `pr.url` present.
- `review_state` display: approved (+/green), changes_requested (!/red), pending (?/yellow), draft (d/dim). Absent or unknown state handled gracefully.
- Integrated into `_compose_line1` after the `added_dirs` section.

**Evidence**: 34 new pytest cases in `statusline/tests/test_t1_t2_t3.py`; consolidated run at `2026-06-06T09:52:32Z` — 181 passed, 3 failed (3 pre-existing failures only).

**Files modified**: `statusline/core.py`, `statusline/types.py`, `statusline/tests/test_t1_t2_t3.py` (new)

#### T2 — `COLUMNS`/`LINES` env vars for width (v2.1.153) — ADOPTED

**Finding**: v2.1.153 added `COLUMNS`/`LINES` env var support for statusline width. `bin/omca-subagent-statusline` was confirmed to be a Python entry (not a shell shim), covered by `statusline/tests/`.

**Implementation**:
- Added `terminal_columns(payload_columns, default=80)` in `statusline/core.py`: priority is payload_columns > COLUMNS env var > default 80.
- `bin/omca-subagent-statusline`: added `os` import and COLUMNS env fallback. Payload field wins; env var is the fallback when payload omits `columns`.

**Evidence**: 34 new pytest cases including COLUMNS-driven truncation scenarios; consolidated run at `2026-06-06T09:52:32Z`.

**Files modified**: `statusline/core.py`, `bin/omca-subagent-statusline`

#### T3 — `context_window.remaining_percentage` pre-calculated field — ADOPTED

**Finding**: New `context_window.remaining_percentage` field provides a pre-calculated context-remaining percentage, avoiding the need to compute it from used/total.

**Implementation**: In `_render_context_bar`, added pre-check: if `ctx_window.remaining_percentage` is present AND the `pct` arg is None, compute `pct = 100.0 - remaining_percentage`. Explicit `pct` arg (used_percentage) still wins. Falls through to existing current_usage calculation as before.

**Evidence**: 34 new pytest cases including remaining_percentage fixture; consolidated run at `2026-06-06T09:52:32Z`.

**Files modified**: `statusline/core.py`

---

### MCP server surface (M1–M3)

#### M1 — stdio MCP gets `CLAUDE_CODE_SESSION_ID` (v2.1.154) — ADOPTED

**Finding**: Since v2.1.154, stdio MCP servers receive `CLAUDE_CODE_SESSION_ID` in their subprocess environment. This enables MCP tools to self-populate session_id without requiring the orchestrating agent to pass it explicitly.

**Equivalence verification (task 1 grounding, oracle F4)**: `CLAUDE_CODE_SESSION_ID` (Bash/MCP subprocess env var) and `CLAUDE_SESSION_ID` (hook-payload env var) carry the same value per OMCA.md:667 ("injected into the Bash tool subprocess environment, matching the session_id value passed to hook scripts"). EQUIVALENT-PROVEN — env-defaulting safe for boulder session tracking.

**Implementation**: Added `_resolve_session_id(session_id: str) -> str` helper in `servers/tools/_common.py`. Helper: explicit non-empty param wins, else falls back to `os.environ.get("CLAUDE_CODE_SESSION_ID", "")`. Applied at two call sites: `boulder_write` and `boulder_task_start` (the only tools taking a `session_id` param — grep-confirmed).

**Evidence**: `evidence_log type=test, 2026-06-06T09:52:04Z` — servers pytest: 141 passed, 1 failed (pre-existing), 6 new tests all pass (boulder_write env/explicit/neither x boulder_task_start env/explicit/neither).

**Files modified**: `servers/tools/_common.py` (new helper), `servers/tools/boulder.py`, `servers/tests/test_boulder.py`

#### M2 — MCP `timeout` <1000ms ignored (v2.1.162) — verified NO-OP

**Finding**: v2.1.162 changed semantics for MCP `timeout` values under 1000ms (they are now ignored). OMCA's `.mcp.json` has zero timeout keys. Servers defined: omca (stdio/uv), grep (http), context7 (http). No code change needed.

**Evidence**: `evidence_log type=manual, 2026-06-06T09:22:50Z`.

#### M3 — Unapproved .mcp.json servers show "Pending approval" (v2.1.154) — DOCUMENT

**Finding**: v2.1.154 added a "Pending approval" indicator for unapproved .mcp.json servers. OMCA users may see this for omca/grep/context7 after a fresh install until they approve via `/mcp`. Added a troubleshooting paragraph to `skills/omca-setup/SKILL.md` DOCTOR MODE Check 4.

**Evidence**: `evidence_log type=manual, 2026-06-06T10:02:39Z`.

**Files modified**: `skills/omca-setup/SKILL.md`

---

### Config/Environment surface (C1–C5)

#### C1 — `fallbackModel` setting (v2.1.166) — DOCUMENT

**Finding**: New `fallbackModel` setting allows specifying a fallback model when the primary is unavailable. No OMCA-specific adoption needed. Documented in OMCA.md Environment Variables section.

#### C2 — `requiredMinimumVersion`/`requiredMaximumVersion` (v2.1.163) — DOCUMENT

**Finding**: New plugin.json fields for enforcing Claude Code version compatibility. OMCA does not currently set these. Documented in OMCA.md for future use.

#### C3 — `CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE` removed (v2.1.160) — verified NO-OP

**Finding**: Removed env var. Grep of entire OMCA repo returned zero matches. The removed variable was never referenced.

**Evidence**: `evidence_log type=manual, 2026-06-06T09:22:45Z`.

#### C4 — `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` (v2.1.154) — DOCUMENT

**Finding**: New env var always enables effort level controls regardless of model. No OMCA-specific adoption. Documented in OMCA.md.

#### C5 — `agent` setting honored for dispatched sessions (v2.1.157) — DOCUMENT

**Finding**: OMCA's `settings.json` already sets `agent` to the appropriate value. The v2.1.157 behavior change means the setting is now honored for dispatched (background) sessions too. No code change needed; OMCA's existing configuration is correct. Documented in OMCA.md.

---

### Output Styles surface (O1–O2)

#### O1 — `force-for-plugin` key validity — verified ACTIVE/VALID

**Finding**: Live documentation check (WebFetch) confirmed `force-for-plugin` is an active, documented output-style frontmatter field: "Plugin output styles only: apply this style automatically whenever the plugin is enabled, without requiring users to select it. Overrides the user's outputStyle setting." OMCA's `output-styles/omca-default.md` using this key is correct.

**Evidence**: `evidence_log type=manual, 2026-06-06T09:22:55Z`.

#### O2 — GFM checkbox rendering of `- [ ]` in responses (v2.1.149) — DOCUMENT

**Finding**: v2.1.149 added GFM task-list checkbox rendering. Relevant for plan-file viewing in Claude Code. Documented in OMCA.md output styles section.

---

## Bug fixes

### Bug A — Subagent wait-reflex ("Waiting." barrier echo)

**Root cause (two vectors)**:

**Vector 1** (subagent-start.sh injection gap): Worker subagents (executor, explore, librarian, hephaestus, multimodal) received no counter-instruction to override the `## Parallel execution` barrier guidance that OMCA injects into ALL subagents from the shared system context. The barrier text ("Waiting for N more agents...") was being faithfully followed by worker subagents, producing bare "Waiting." or "Done." final messages instead of deliverables.

**Vector 2** (orchestration-block.md scope gap — ROOT CAUSE): The live `~/.claude/CLAUDE.md` managed block (injected by omca-setup) carries the `## Parallel execution` section without any scoping qualifier. The block is auto-loaded into every session, including subagent sessions, making the barrier guidance appear authoritative to all agent identities.

**Fixes**:
- Vector 1 (`scripts/subagent-start.sh`): New dedicated case arm matching `*executor*|*explore*|*librarian*|*hephaestus*|*multimodal*` added immediately after the "External Access" arm (lines ~104-110). Appends one counter-instruction line to `CONTEXT_PARTS`. Excluded: oracle/momus (advisory/review roles whose clarification/wait behavior must remain intact), sisyphus/prometheus/metis (orchestrator roles that legitimately use barrier patterns). Bats assertions: PRESENT for executor/explore/librarian/hephaestus; ABSENT for sisyphus/momus/oracle.

- Vector 2 (`skills/omca-setup/orchestration-block.md`): Added scoping callout at line 52 directly below the `## Parallel execution` heading: "> **Main-session orchestrator (sisyphus) only.** If you are a subagent (executor, explore, librarian, oracle, hephaestus, or any other spawned agent), this section does NOT apply to you. Subagents must never wait for other agents — always complete your assigned work and end with your full deliverable."

**E2e verification (vector 1)**: Cache rebuilt to v2.5.2 before probe. Adversarial executor spawn with barrier-bait prompt ("waiting for 3 more agents... Background Agent Barrier applies") returned a full deliverable with STATUS/EVIDENCE sections — no wait/holding behavior. Vector 1 PASS.

**Evidence**: `evidence_log type=test, 2026-06-06T09:39:48Z` (subagent_start.bats 23/23 — counter-instruction PRESENT for executor/explore/librarian/hephaestus, ABSENT for sisyphus/momus/oracle). `evidence_log type=manual, 2026-06-06T09:41:56Z` (grep: scoping callout present at orchestration-block.md:52). `evidence_log type=manual, 2026-06-06T09:43:57Z` (e2e live verification: executor returned deliverable, not wait message; cache rebuild prerequisite confirmed).

**Files modified**: `scripts/subagent-start.sh`, `tests/bats/hooks/subagent_start.bats`, `skills/omca-setup/orchestration-block.md`

---

### Bug B — Keyword-detector activates on task-notification relay text

**Root cause (DEFECT-PROVEN)**:

A platform-relayed `<task-notification>` block (55.4KB agent inventory result from background agents) reached `UserPromptSubmit` hook as `.prompt` at `2026-06-06T07:48:36Z`. The notification text contained "ralph", "ultrawork", and "handoff" as skill names in the inventory payload.

Guard 1 (`agent_id` check at keyword-detector.sh:10-13): **INSUFFICIENT** — only blocks hooks firing inside subagent context. `UserPromptSubmit` for task-notification turns fires in the MAIN session context; no `agent_id` present.

Guard 2 (`mode_already_announced` at :32-86): **INSUFFICIENT for first occurrence** — only prevents re-announcement after the first detection. Does not prevent the initial false-positive.

State evidence: `active-modes.json` confirms ralph/ultrawork/handoff `detected_at=1780732116` (07:48:36Z), `session_id=d251a5e9-5337-469d-b56c-35f11daaad6a`. `ralph-state.json.activatedAt="2026-06-06T07:48:36Z"` — ralph persistence mode was fully WRITTEN (not just announced).

**Fix** (`scripts/keyword-detector.sh:23-31`): Added task-notification relay guard after the empty-prompt exit, before PROMPT_LOWER computation. Uses first-500-char window check: if `"${PROMPT:0:500}"` matches `*"<task-notification>"*`, exit 0 before any keyword matching. First-500-char window (not strict `^`) handles system-reminder wrappers that may precede the tag.

**Tradeoff documented in code**: a genuine user message containing `<task-notification>` in the first 500 chars while also requesting ralph/ultrawork/etc. will be suppressed. Accepted: `<task-notification>` is a platform XML element, not natural human text; false-positive risk is negligible.

**Evidence**: `evidence_log type=manual, 2026-06-06T09:24:15Z` (bug-b DEFECT-PROVEN, state evidence). `evidence_log type=test, 2026-06-06T09:47:12Z` — keyword_detector.bats 28/28 (test 27: task-notification with mode keywords → exit 0, no state writes; test 28: genuine "ralph don't stop" → RALPH MODE DETECTED, regression guard). Independent orchestrator verification at `2026-06-06T09:48:47Z`.

**Files modified**: `scripts/keyword-detector.sh`, `tests/bats/hooks/keyword_detector.bats`

---

## Documentation updates (Phase D)

### OMCA.md (task 16) — 59 version annotations, 12 new subsections

Sections added/updated:
- **Hooks**: new_platform_events table (5 events, v2.1.152); Stop/SubagentStop input fields background_tasks+session_crons (v2.1.145); additionalContext output non-adoption note (v2.1.163); SessionStart sessionTitle (ADOPTED) + reloadSkills (v2.1.152); stop-block cap 8 + `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (v2.1.143, ADOPTED); terminal-access loss + terminalSequence (v2.1.141+); if: semantics update (v2.1.163, NO-OP for OMCA).
- **Skills**: disallowed-tools frontmatter (v2.1.152, ADOPTED on github-triage + hephaestus); `\$` escape syntax (v2.1.163, NO-OP); /reload-skills command (v2.1.152); workflow->ultracode rename (v2.1.157, NO-OP).
- **Agents**: lean system prompt (v2.1.154); subagent_type case/separator-insensitive (v2.1.140); inline mcpServers strict-mcp (v2.1.153, NO-OP); multiple Agent types fix (v2.1.147, NO-OP).
- **plugin.json** (NEW section): displayName (v2.1.143, ADOPTED); defaultEnabled (v2.1.154, NOT adopted); root-SKILL.md (v2.1.142); dependency enforcement (v2.1.143).
- **Statusline** (NEW subsection): repo/PR segment (v2.1.145, ADOPTED); COLUMNS env (v2.1.153, ADOPTED); remaining_percentage (v2.1.153, ADOPTED).
- **MCP** (NEW section): `CLAUDE_CODE_SESSION_ID` env (v2.1.154, ADOPTED via _resolve_session_id); timeout <1000ms ignored (v2.1.162, NO-OP); pending approval indicator (v2.1.154).
- **Environment Variables**: CLAUDE_CODE_ALWAYS_ENABLE_EFFORT (v2.1.154); CLAUDE_CODE_ENABLE_AUTO_MODE (v2.1.158); agent setting dispatched (v2.1.157); fallbackModel (v2.1.166); requiredMinimumVersion/requiredMaximumVersion (v2.1.163); CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE removed (v2.1.160).
- **Output Styles**: force-for-plugin re-verified 2026-06-06; GFM task-list checkboxes (v2.1.149).
- **Deliberate Non-Adoptions** (NEW section): 8-item table covering additionalContext, 5 new hook events, skills preload, spawn-allowlist, defaultEnabled:false, reloadSkills, prompt/agent/http hooks, monitors/themes/channels/LSP.

**Evidence**: `evidence_log type=manual, 2026-06-06T10:00:07Z` (executor) + `2026-06-06T10:00:56Z` (orchestrator independent verification — OMCA.md +290 lines, 62 in-range annotations, deliberate non-adoptions section at :1026).

### README.md + omca-setup/SKILL.md (task 17)

- **README.md**: Added v2.1.154 note to `worktree.baseRef` section: "head" correctly resolves to current worktree HEAD (not main checkout HEAD). No other version claims invalidated.
- **SKILL.md**: `/reload-skills` (v2.1.152+) added to install/update flow; pending approval paragraph (v2.1.154+) added to DOCTOR MODE Check 4; Phase 5.6 item 7 version bumped from v2.1.141 to v2.1.167 (permission banner limitation still unresolved at end of sync window).

**Evidence**: `evidence_log type=manual, 2026-06-06T10:02:39Z` (executor) + `2026-06-06T10:03:16Z` (orchestrator independent verification — README.md +4, SKILL.md +5/-1).

---

## Verification summary

### Consolidated test runs

| Suite | Result | Pre-existing failures | New tests added |
|---|---|---|---|
| `bash scripts/validate-plugin.sh` | 160 passed, 0 failed, 6 skipped, exit 0 | — (baseline was 160/0/1; 5 new skips for H6 events) | H6 new_platform_events array |
| `bats tests/bats/hooks/ralph_persistence.bats` | 17/17 pass | — | 3 new (H1a cap-yield, H1b progress-reset, H2 background_tasks) |
| `bats tests/bats/hooks/keyword_detector.bats` | 28/28 pass | — | 2 new (test 27: task-notification guard, test 28: genuine ralph regression) |
| `bats tests/bats/hooks/subagent_start.bats` | 23/23 pass | — | 7 new (counter-instruction present/absent assertions) |
| `bats tests/bats/hooks/session_lifecycle.bats` | 12/12 pass | — | 3 new (sessionTitle present/absent, additionalContext preserved) |
| `cd statusline && uv run pytest tests/ -q` | 181 passed, 3 failed, exit 1 | 3 pre-existing (TestNewFieldsLine2: root-schema token/api expectations) | 34 new (test_t1_t2_t3.py) |
| `cd servers && uv run pytest tests/ -q` | 141 passed, 1 failed, exit 1 | 1 pre-existing (test_initialize_latency_warm_cache) | 6 new (boulder session-id env defaulting) |

### Phase C consolidated barrier verification

`evidence_log type=test, 2026-06-06T09:55:14Z` (orchestrator, post-barrier): validate-plugin.sh 160/0/6 exit 0; statusline 181 pass/3 pre-existing fail; servers 141 pass/1 pre-existing fail; plugin.json displayName="Oh My ClaudeAgent", version 2.5.2 == marketplace.json 2.5.2. All Phase C tasks (10-15) verified: sessionTitle bats, statusline T1/T2/T3, disallowed-tools, displayName, MCP session-id default, agent audit.

### Evidence log summary

Total evidence entries logged: 38 entries across the sync session. Types: `manual` (grounding probes, e2e verification, documentation diffs), `test` (bats + pytest runs), per-task and orchestrator independent verification entries. All build/test/lint commands logged via `evidence_log` MCP tool per verification protocol.

---

## Deferred items

### 1. Bug A vector-2 live acceptance (blocking deferral — requires new session)

**Status**: CLOSED 2026-06-10 — verified in a new session with the scoped block live in `~/.claude/CLAUDE.md` (re-injected 2026-06-06 post-release) and installed plugin at 2.6.0. An explore worker spawned with direct barrier bait ("3 agents still running… Background Agent Barrier applies — apply it on every partial completion") completed its lookups and did NOT exhibit wait/barrier behavior. Residual (separate from Bug A): its first final message was a bare "Done." — correct values emitted on one resume; terse-final compression is a distinct failure mode, tracked in plan posttoolbatch-and-deferred-fixes notepad.

~~Deferred by design.~~ Original deferral context below for the audit trail.

**What remains**: `skills/omca-setup/orchestration-block.md` has been edited (task 7 — scoping callout at line 52). However, the live `~/.claude/CLAUDE.md` still carries the **pre-task-7** managed block (the old un-scoped barrier text), because omca-setup block injection only runs when triggered explicitly and the cache must be rebuilt at the new version first.

**Acceptance path**: (1) Task 19 completes the version bump and rebuilds the plugin cache at the new version; (2) user runs `/oh-my-claudeagent:omca-setup` in a new session — this re-injects the updated block into `~/.claude/CLAUDE.md`; (3) spawn an executor subagent in the new session and confirm it returns a deliverable without wait/barrier behavior. Only then is Bug A vector-2 fully verified.

**Evidence of deferral**: `evidence_log type=manual, 2026-06-06T09:43:57Z` — "this validates VECTOR 1 only; vector-2 e2e acceptance deferred — requires omca-setup re-run (live ~/.claude/CLAUDE.md still has old block) + new session."

### 2. Bug A residual — prompt-implied barriers re-trigger wait-reflex (observed in Phase C)

**Observation** (from notepad learnings, 2026-06-06T09:53:36Z): During Phase C fan-out, 4/5 parallel executors returned wait/terse finals ("Waiting.", "Done.", "complete. Waiting for 2 parallel executors.") despite vector-1 counter-instruction being active in cache. Two contributing factors identified:

1. Live `~/.claude/CLAUDE.md` still carries the old un-scoped barrier block (vector-2 re-injection deferred to post-task-19 by design).
2. Orchestrator delegation prompts mentioned "Phase C parallel group / other executors / consolidated verification after all tasks land" — wording that invites peer-waiting even without the managed block.

**Lesson for future prompts**: delegation prompts must state "your task is complete when YOUR changes land — peers are irrelevant to your completion." Vector-2 live acceptance remains the decisive structural fix; counter-instruction alone does not fully neutralize prompt-implied barriers when orchestrator prompts contain peer-referencing language.

### 3. Pre-existing test debt (not introduced by this sync)

| Suite | Test | Root cause |
|---|---|---|
| `statusline` TestNewFieldsLine2::test_token_count_shown | Expects token count at root of data instead of `context_window` path (pre-v2.1.132 schema) | Baseline: 3 failed/147 passed before task 11 |
| `statusline` TestNewFieldsLine2::test_token_count_only_input | Same root cause | Same |
| `statusline` TestNewFieldsLine2::test_api_duration_shown | Expects `api_duration` at root instead of nested `cost` path | Same |
| `servers` test_startup_latency::test_initialize_latency_warm_cache | Timing-sensitive intermittent failure | Baseline: 1 failed/135 passed before task 14 |

None of these were introduced by this sync. Per plan constraints, not fixed in scope.

### 4. Cosmetic stale string in final-verification-evidence.sh (not introduced by this sync)

`final-verification-evidence.sh:315` contains a stale `"evidence.jsonl"` string (canonical file is `verification-evidence.json`). Opportunistic fix was gated on "only if this file is edited anyway" — the file was NOT edited during this sync (H3 resolved as DOCUMENT-only). Listed for the next maintenance window that touches this script.

---

## Disposition table — complete coverage verification

| # | Item | Disposition | Outcome | Evidence timestamp |
|---|------|-------------|---------|-------------------|
| H1 | Stop-block cap 8 | ADOPTED | ralph-cap-state.json + 3 new bats | 2026-06-06T09:32:11Z |
| H2 | background_tasks/session_crons | VERIFY -> NO-OP (orthogonal) | No code change; bats test 17 confirms | 2026-06-06T09:32:11Z |
| H3 | additionalContext | DOCUMENT-ONLY (schema inconclusive; exit-2 ignores JSON) | No code change; OMCA.md + CHANGELOG | 2026-06-06T09:33:54Z |
| H4 | sessionTitle | ADOPTED | session-init.sh + 3 new bats | 2026-06-06T09:50:43Z |
| H5 | reloadSkills | DOCUMENT | OMCA.md hooks section | 2026-06-06T10:00:07Z |
| H6 | New platform events (5) | validator-aware (new_platform_events array) | validate-plugin.sh: 160/0/6 | 2026-06-06T09:36:09Z |
| H7 | Terminal access loss | VERIFY -> NO-OP | grep: zero /dev/tty or tput in notify.sh | 2026-06-06T09:22:25Z |
| H8 | if: semantics | VERIFY -> NO-OP | All 12 clauses are command-name-only globs | 2026-06-06T09:22:29Z |
| S1 | disallowed-tools | ADOPTED partial (github-triage [Write,Edit] + hephaestus [Agent]; metis/momus justified-skip) | SKILL.md frontmatter added; validator green | 2026-06-06T09:50:59Z |
| S2 | \$ escape | VERIFY -> NO-OP | grep: zero \$[0-9] in commands/skills | 2026-06-06T09:22:34Z |
| S3 | workflow->ultracode | VERIFY -> NO-OP | grep: zero platform workflow refs | 2026-06-06T09:22:38Z |
| S4 | /reload-skills | DOCUMENT | SKILL.md install/update flow | 2026-06-06T10:02:39Z |
| S5 | context:fork fix | VERIFY (exercised live) | metis/momus forks returned during planning | live session |
| A1 | Lean system prompt | VERIFY CLEAN (10/10 agents) | Zero stale references; zero edits required | 2026-06-06T09:51:18Z |
| A2 | skills: preload | SKIP | CHANGELOG non-adoption; context cost rationale | 2026-06-06T10:00:07Z |
| A3 | Plugin agent frontmatter ignored | DOCUMENT | OMCA.md agents section new paragraph | 2026-06-06T09:51:18Z |
| A4 | spawn-allowlist | SKIP -> DOCUMENT | CHANGELOG non-adoption; sisyphus needs full spawn | 2026-06-06T10:00:07Z |
| A5 | inline mcpServers | VERIFY -> NO-OP | grep: zero mcpServers in agents/ | 2026-06-06T09:22:43Z |
| P1 | displayName | ADOPTED | plugin.json field + parity check passes | 2026-06-06T09:55:14Z |
| P2 | defaultEnabled | SKIP | CHANGELOG non-adoption; keep enabled-on-install | 2026-06-06T10:00:07Z |
| P3 | Root-SKILL.md | DOCUMENT | OMCA.md plugin.json section | 2026-06-06T10:00:07Z |
| P4 | Plugin dependencies | DOCUMENT | OMCA.md plugin.json section | 2026-06-06T10:00:07Z |
| T1 | workspace.repo.* + pr.* | ADOPTED | _compose_repo_pr + 34 new pytest cases | 2026-06-06T09:52:32Z |
| T2 | COLUMNS/LINES env | ADOPTED | terminal_columns() + bin/omca-subagent-statusline | 2026-06-06T09:52:32Z |
| T3 | remaining_percentage | ADOPTED | _render_context_bar pre-check | 2026-06-06T09:52:32Z |
| M1 | CLAUDE_CODE_SESSION_ID | ADOPTED | _resolve_session_id + 6 new pytest cases | 2026-06-06T09:52:04Z |
| M2 | timeout <1000ms | VERIFY -> NO-OP | .mcp.json: zero timeout keys | 2026-06-06T09:22:50Z |
| M3 | Pending approval | DOCUMENT | SKILL.md DOCTOR MODE Check 4 | 2026-06-06T10:02:39Z |
| C1 | fallbackModel | DOCUMENT | OMCA.md env vars section | 2026-06-06T10:00:07Z |
| C2 | requiredMin/MaxVersion | DOCUMENT | OMCA.md env vars section | 2026-06-06T10:00:07Z |
| C3 | CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE | VERIFY -> NO-OP | grep: zero refs in repo | 2026-06-06T09:22:45Z |
| C4 | CLAUDE_CODE_ALWAYS_ENABLE_EFFORT | DOCUMENT | OMCA.md env vars section | 2026-06-06T10:00:07Z |
| C5 | agent setting dispatched | DOCUMENT | OMCA.md env vars section | 2026-06-06T10:00:07Z |
| O1 | force-for-plugin validity | VERIFY VALID | WebFetch: documented active field | 2026-06-06T09:22:55Z |
| O2 | GFM checkboxes | DOCUMENT | OMCA.md output styles section | 2026-06-06T10:00:07Z |
| Bug A | Subagent wait-reflex | ADOPTED (vector 1 verified; vector 2 deferred) | subagent-start.sh + orchestration-block.md + 7+2 bats | 2026-06-06T09:43:57Z |
| Bug B | Keyword-detector task-notification | ADOPTED (DEFECT-PROVEN) | keyword-detector.sh + 2 new bats (28/28) | 2026-06-06T09:47:12Z |

**Total rows**: 36/36 covered. **Gaps**: none — all rows have notepad decisions entry or evidence timestamp.

---

**End of report.** Next: task 19 (CHANGELOG entry, version bump to v2.6.0, cache rebuild at new version path, final validate-plugin.sh + pytest runs).
