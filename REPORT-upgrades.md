# OMCA Sync Audit — Claude Code v2.1.92 → v2.1.133 + Hook System Audit

**Type**: Single source of truth for the upcoming implementation plan.
**Scope**: Platform alignment (Claude Code v2.1.92 → v2.1.133) plus an in-depth hook-system audit (~33 hook scripts reviewed by 4 parallel auditors).
**Status**: All 85 master-roster items implemented across ~59 atomic commits. Output-style migration (§3) is DONE and shipped in **v2.1.0** (commits `2165bbc..7af5493` on `main`, local tag `v2.1.0` at `7af5493`). Release finalization complete except the final `git push origin main --tags` (gated on user approval per project policy). Smoke-test confirmed orchestration body delivered via output-style: see `.omca/notes/output-style-rollout-smoke.md` (2026-05-13).
**Compiled**: 2026-05-10. v3 incorporated review fixes; v4 merged HOOK-AUDIT findings into a severity-sorted master roster; v5 reflects post-execution implementation state; v6 (2026-05-13) marks the output-style migration and v2.1.0 release complete.

---

## Implementation status (post-execution snapshot)

| Severity | Items | Status |
|---|---|---|
| CRITICAL (C-1..C-10) | 10 | ✅ DONE — all 10 contract violations and silent-broken hooks fixed |
| HIGH (H-1..H-23) | 23 | ✅ DONE — schema sweeps, contract decisions, audit/enhance work all landed |
| MEDIUM (M-1..M-28) | 28 | ✅ DONE — defensive-slop swept, dead helpers removed, polish complete |
| LOW (L-1..L-24) | 24 | ✅ DONE — comments, magic-number derivations, regex tightening, doc sweep |

**Total**: 85/85 master-roster items implemented + 4 baseline-fix commits + 1 shellcheck-fix commit. Cumulative `just ci` exit 0; `just test-bats` 371/371 pass; `just test-mcp` 27/27 pass. Per-row commit references are in git history (use `git log --grep` against any keyword in the row's one-line description).

**Remaining work** (subject of this follow-up plan):
1. Output-style migration (§3 below) — the explicitly-deferred item from the original execution.
2. Release finalization — CHANGELOG entry, `just release` version bump, plugin tag push.
3. Hook-audit re-run pass — sample-based oracle/explore audit to confirm the 85-item sweep introduced no new defects.

---

## Master roster — every fix/implementation by severity

Each row: ID, type (`BUG` = proven defect; `IMPL` = adoption / migration / documentation), file(s), one-line description, effort estimate. Cross-references go to the detail chapters below.

### CRITICAL — silently broken or contract violations (10 items)

| ID | Type | File | One-line | Effort | Detail |
|---|---|---|---|---|---|
| C-1 | BUG | `scripts/notify.sh:7` | Reads `.type` but platform sends `.notification_type`; case never matches `idle_prompt`/`permission_prompt`; all customizations dead code | 10min | §5.3 |
| C-2 | BUG | `scripts/lifecycle-state.sh:220` | WorktreeRemove reads `.name` but platform sends `.worktree_path`; hook always exits with "non-empty name" error; **`.omca/state/worktrees/` tracking files never cleaned** | 15min | §5.4 |
| C-3 | BUG | `scripts/empty-task-response.sh:6, 32` | Reads `.tool_response // .tool_result` and top-level `.agent_name`/`.subagent_type`; correct paths are `.tool_response` (Agent returns structured object) and `.tool_input.subagent_type`; **whole hook is non-functional today** | 30min | §5.5 |
| C-4 | BUG | `scripts/delegate-retry.sh:9` | `// "Task"` fallback but matcher is `Agent`; counter file uses `Task:delegate_error` while every other Agent-error tracker uses `Agent:` — **counter state silently fragmented** | 20min | §5.6 |
| C-5 | BUG | `scripts/agent-usage-reminder.sh:10` | Race against SubagentStart timing; reads `active-agents.json` (populated by `subagent-start.sh`) before SubagentStart fires; reminder fires when it shouldn't during ultrawork fan-out | 30min | §5.7 |
| C-6 | BUG | `scripts/post-edit.sh:10` | Reads `.tool_result.success` (canonical is `.tool_response.success`); `edits.jsonl` `success` column is constant `true` regardless of reality | 10min | §5.8 |
| C-7 | BUG | `scripts/write-guard.sh` | PreToolUse `additionalContext` fires post-tool but messages read as pre-write guidance; doesn't actually return `permissionDecision: "deny"`; local `emit_context` shadows `common.sh` helper with different signature | 30min | §5.9 |
| C-8 | BUG | `scripts/final-verification-evidence.sh:95-99` | Cross-session active_plan-without-marker falls through to F1-F4 demand (firing live throughout this session) | 30min | §5.1 |
| C-9 | BUG | `scripts/final-verification-evidence.sh:149-163, 187-202` | `has_ftype` 4-way OR clause accepts entries with null/empty `plan_sha256` as legacy fallback — same staleness vector C-8 closes, hit via different path. SHA cross-check at 187-202 only queries legacy entries, missing modern entries with first-class SHAs | 30min | §5.10 |
| C-10 | BUG | `scripts/keyword-detector.sh` | Mode keyword echoes from system reminders re-fire detection (RALPH/ULTRAWORK/HANDOFF/METIS injections firing live this session); fix gates on detection-already-active state | 30min | §5.2 |

### HIGH — schema drift, contract issues, scope-of-impact (23 items)

| ID | Type | File | One-line | Effort | Detail |
|---|---|---|---|---|---|
| H-1 | BUG | `scripts/{bash,read,edit,delegate,json}-error-recovery.sh`, `scripts/post-edit.sh` | 6 recovery scripts read `.tool_error` or `.tool_result.error`; **neither field is documented in `hooks.md`**; canonical is `.error` only. Sweep + add `validate-plugin.sh` grep check | 1h | §5.11 |
| H-2 | BUG | `scripts/permission-filter.sh`, `hooks.json:88-105` | Script contradicts CLAUDE.md ("guardrail-only"): auto-allows `npm/bun/yarn/pnpm/jq/uv`. Plus `sudo rm` regex is dead code (no `Bash(sudo *)` registration). Plus missing `if:` filters for `bun *`, `yarn *`, `pnpm *` | 1h | §5.12 |
| H-3 | BUG | `scripts/lifecycle-state.sh:156, 252` | Exits 1 on `CwdChanged`/`FileChanged` default cases; those events have no decision control on exit code per `hooks.md:562`; transcript shows `lifecycle-state.sh hook error` notice for nothing | 15min | §5.13 |
| H-4 | BUG | `scripts/lifecycle-state.sh:164` | Emits `watchPaths` inside `hookSpecificOutput`; field is undocumented in `hooks.md`; likely silently ignored. Either remove (dead output) or verify empirically | 30min | §5.14 |
| H-5 | BUG | `scripts/delegate-retry.sh`, `scripts/edit-error-recovery.sh` | `jq ... 2>/dev/null \|\| echo` pattern on error-counts file: silent data loss when jq fails — `\|\| echo` overwrites with single-key object, destroying other counter state | 20min | §5.15 |
| H-6 | BUG | `scripts/final-verification-evidence.sh:165` | `has_ftype` jq filter uses `2>/dev/null \|\| echo "false"`; in a Stop-blocking hook, swallowed parse errors silently demand evidence even when present. Undermines explicit corruption guard at lines 133-138 | 15min | §5.16 |
| H-7 | BUG | `scripts/task-completed-verify.sh:35-40, 59` | Two issues: regex `(verify\|test\|build\|...)` matches without word boundaries (false positives on "verification", "implementation"). Stat-failure path sets `RECENT_EVIDENCE=true` — fail-OPEN for a verification gate | 45min | §5.17 |
| H-8 | BUG | `scripts/subagent-complete.sh:12` | Records all SubagentStops as `status: "completed"` regardless of actual outcome; SubagentStop fires on stalls/timeouts too. Inspect `last_assistant_message` length or `agent_transcript_path` size | 30min | §5.18 |
| H-9 | BUG | `scripts/session-init.sh:72, 78` | `grep -q "OMC:START\|omca-setup"` uses BRE alternation `\|`; on macOS BSD grep without `-E` this matches a literal `\|` → neither alternative matches → cross-platform regression | 10min | §5.19 |
| H-10 | BUG | `scripts/session-init.sh:10-17` | `cp` runs before `uv sync`; sync failure silently masked (cached pyproject updated, venv broken; next session sees `diff -q` succeed and skips re-sync) | 15min | §5.20 |
| H-11 | BUG | `scripts/instructions-loaded-audit.sh:18-22` | Trailing-`?` operators on `.session_id?`, `.cwd?` etc. are defensive-slop; common fields are always present per `hooks.md:516+` | 10min | §5.21 |
| H-12 | BUG | `scripts/subagent-start.sh:127`, `scripts/subagent-complete.sh:40` | `flock -w 5 \|\| log_hook_error` proceeds to read-modify-write WITHOUT holding the lock on timeout; concurrent registrations race. Should `exit 0` from subshell on flock failure | 20min | §5.22 |
| H-13 | IMPL | `.claude/rules/state-schemas.md` (new) | `subagents.json` and `active-agents.json` use different field names (`.type` vs `.agent`) for the same concept; document canonical schemas | 1h | §5.23 |
| H-14 | IMPL | `CLAUDE.md`, `.claude/rules/agent-conventions.md`, `scripts/validate-plugin.sh`, every `skills/*/SKILL.md` over 250 chars | Skill description cap raised 250 → 1,536 chars in v2.1.105; OMCA enforces 250. Update enforcement; rewrite over-cap descriptions (consolidate-memory ≈ 895 chars confirmed, others suspected). Add internal soft-cap recommendation ≤512 | 2h | §6.2 |
| H-15 | IMPL | `tests/pytest/test_startup_time.py` (new), `.mcp.json`, `scripts/session-init.sh` | Bench omca MCP server cold-start vs warm-start; if reliably <2s warm, add `alwaysLoad: true` to `.mcp.json`. Risk: 5s startup-blocking cap on alwaysLoad. May need unconditional uv-sync warmup in `session-init.sh` | 2h | §7.1 |
| H-16 | IMPL | `servers/tools/validate_plan_write.py` (new), `servers/main.py`, `hooks/hooks.json`, delete `scripts/plan-checkbox-verify.sh` | Migrate `plan-checkbox-verify.sh` to `type: "mcp_tool"`. Gated by FastMCP block-shape prototype: verify FastMCP can return `{decision: "block", reason: ...}` and platform `mcp_tool` handler honors it. Paired commit removes both old script and registration | 3h | §1.2 |
| H-17 | IMPL | `scripts/pre-compact.sh`, `tests/bats/hooks/pre_compact.bats` | Already-registered hook; audit for F1-F4-freshness gating during plan execution; enhance if missing. **Depends on C-8 fix** | 1h | §1.1.1 |
| H-18 | IMPL | `scripts/session-cleanup.sh`, `tests/bats/hooks/session_end.bats`, `hooks.json:289-298` | Already-registered hook; audit for end-of-session sweep (stale state, expired markers, async backlog flush). Add `"timeout": 5000` to handle large state trees | 1h | §1.1.2 |
| H-19 | IMPL | `CLAUDE.md` | Document `worktree.baseRef` (v2.1.133 default `fresh` drops unpushed commits in worktree-isolation agents) | 20min | §2.4 |
| H-20 | IMPL | `servers/` Python source review | Audit for stdout pollution; non-JSON to stdout breaks stdio MCP per v2.1.110 regression history. FastMCP defaults to stderr but custom prints could leak | 1h | §4.3 |
| H-21 | IMPL | `tests/bats/` sweep | Audit for "stderr should be empty" assertions broken by v2.1.98's visible-stderr change | 1h | §1.4 |
| H-22 | BUG | `scripts/post-compact-inject.sh:30-33` | Sanitization can be bypassed when ALL lines match injection patterns; `cat` fallback re-reads unsanitized file. Drop fallback; distinguish "all matched" from "grep failed" via exit code | 20min | §5.24 |
| H-23 | IMPL | `CLAUDE.md` user-config section, `skills/handoff/SKILL.md` note | Document `skillOverrides: { "oh-my-claudeagent:handoff": "user-invocable-only" }` recommendation per user direction | 15min | §2.3 |

### MEDIUM — cleanup, defensive-slop, dead code (28 items)

| ID | Type | File | One-line | Effort |
|---|---|---|---|---|
| M-1 | BUG | `scripts/lib/common.sh` | `check_sidecar_idempotency` and `mode_state_path` have ZERO callsites — delete | 10min |
| M-2 | BUG | `scripts/lib/common.sh` | `resolve_session_id`, `compute_sidecar_path`, `sidecar_sha_matches`, `mode_state_name` violate documented ≥3-callsite rule. Inline into final-verification-evidence.sh + session-cleanup.sh | 30min |
| M-3 | BUG | `scripts/track-subagent-spawn.sh:18-20` | `RANDOM % 1000` SPAWN_ID has 1-in-1000 collision rate per second; ultrawork 10-agent fan-out hits ~5%. Use `date +%s%N` if available, fall back to `seconds-$$-RANDOM` | 15min |
| M-4 | BUG | `scripts/post-edit.sh:23-26` | Atomic write race for parallel Write/Edit; concurrent calls drop one's `recent-edits.json` update. Use `flock` like `subagent-start.sh:127` | 20min |
| M-5 | BUG | `scripts/context-injector.sh:35, 41` | `head -c 2000` byte-cuts UTF-8 mid-codepoint. Use `head -n` or wc-based line truncation | 15min |
| M-6 | BUG | `scripts/context-injector.sh:30` | Tree-walk cache never invalidates on `AGENTS.md` modification; add mtime check or content-hash key | 20min |
| M-7 | BUG | `scripts/post-compact-inject.sh:23` | Magic number `200` undocumented (rule violation). Add derivation comment | 5min |
| M-8 | BUG | `scripts/keyword-detector.sh:43` | Cancel keyword regex too broad — matches "Cancel my plan", "stop the music". Require longer phrase boundaries | 20min |
| M-9 | BUG | `scripts/keyword-detector.sh:87-95` | Direct `.tmp` write instead of `mktemp` per OMCA convention | 10min |
| M-10 | BUG | `scripts/ralph-persistence.sh:20-28` | Boulder mtime check fail-OPEN — when stat fails, `boulder_age` ≈ epoch, age check returns false, block doesn't fire. Either fail-closed or remove the stat-availability gate | 15min |
| M-11 | BUG | `scripts/ralph-persistence.sh:114-167` | `_`-prefixed locals violate explicit "No `_` prefix" rule from `.claude/rules/hook-scripts.md` | 15min |
| M-12 | BUG | `scripts/teammate-idle-guard.sh:28-30` | `[0]` picks first matching agent by type; if multiple agents share a type (parallel fan-out), wrong one is checked. Use `max_by(.started_epoch)` | 20min |
| M-13 | BUG | `scripts/json-error-recovery.sh` | Global fallback overlaps per-tool handlers — Edit failures with "JSON" in error fire BOTH `edit-error-recovery.sh` AND this hook. Add explicit exclusion list OR split per-tool | 30min |
| M-14 | BUG | `scripts/agent-usage-reminder.sh:29, 31` | Raw `jq -r ... 2>/dev/null` instead of `jq_read`; arithmetic on potentially empty `COUNT` triggers reminder on every error path | 15min |
| M-15 | BUG | `scripts/session-cleanup.sh:14` | Stale "line-number stability" comment justifying rejected `jq_read` migration. Either fix the test that depends on line numbers, OR delete the comment and migrate | 30min |
| M-16 | BUG | `scripts/pre-compact.sh:34` | `tail -50` on JSONL may miss `subagent_spawn` events when log dominated by completions. Increase tail window or filter at source | 20min |
| M-17 | BUG | `scripts/pre-compact.sh:66` | `jq -r '.x // ""' "$F" 2>/dev/null \|\| echo ""` is the canonical OMCA defensive-slop anti-pattern | 5min |
| M-18 | IMPL | `.claude/rules/hook-scripts.md` | Convention enumerates exit-2 users as `task-completed-verify.sh` and `teammate-idle-guard.sh`. Reality includes `final-verification-evidence.sh` and `plan-checkbox-verify.sh`. Update doc | 10min |
| M-19 | BUG | `scripts/config-change-audit.sh:13` | Writes `config-changes.log` while every other log is `.jsonl`. Rename | 5min |
| M-20 | BUG | `scripts/empty-task-response.sh` | No timing log via `hook_timing_log` despite OMCA convention. Add `_HOOK_START` capture | 5min |
| M-21 | BUG | `scripts/post-edit.sh` | Async hook with no JSON output emits empty transcript on pre-v2.1.119 platforms. Add `printf '{}\n'` defensive belt | 5min |
| M-22 | BUG | `scripts/permission-filter.sh:21-27` | Blanket `npm *` auto-allow runs untrusted package install scripts. Narrow to specific subcommands (`npm run *`, `npm test`, `npm ci`) | 30min |
| M-23 | BUG | `scripts/post-compact-inject.sh:35` | `wc -l` off-by-one — `echo` adds trailing newline. Use `printf '%s' "${CLEANED}" \| wc -l` | 10min |
| M-24 | BUG | `scripts/session-init.sh:19` | `SESSION_ID="${CLAUDE_SESSION_ID:-$(date +%s)-$$}"` fallback path inconsistent with `resolve_session_id` priority; either remove fallback or document | 15min |
| M-25 | IMPL | `scripts/validate-plugin.sh` | Add grep check failing CI on phantom field names (`tool_result\b`, `tool_error\b`, etc.) — prevents H-1 regression | 30min |
| M-26 | BUG | `scripts/lifecycle-state.sh:189` | `git -C "${repo_root}" worktree add --detach` fails silently on non-git projects. Either deregister WorktreeCreate or handle non-git case | 30min |
| M-27 | IMPL | `hooks.json` PreToolUse Write groups | Two separate `PreToolUse Write` matcher entries (`write-guard.sh` and `plan-checkbox-verify.sh`); consolidate into one entry with two handlers | 10min |
| M-28 | IMPL | `output-styles/omca-default.md` | Verify current frontmatter doesn't claim `force-for-plugin: true` (it doesn't currently); document this is the pre-Track-3 state | 5min |

### LOW — polish, comments, magic-number derivations (24 items)

| ID | Type | File | One-line |
|---|---|---|---|
| L-1 | BUG | `scripts/track-question.sh:9` | No session-ID isolation; concurrent sessions share `pending-question.json` |
| L-2 | BUG | `scripts/track-question.sh:9` | Builds JSON via concatenation instead of `jq -nc` |
| L-3 | BUG | `scripts/comment-checker.sh:9` | Edit/Write shape branching brittle if matcher widens to MultiEdit/NotebookEdit |
| L-4 | BUG | `scripts/edit-error-recovery.sh:21` | `not.found` regex uses `.` as wildcard; matches "notXfound", "not.found" too |
| L-5 | BUG | `scripts/edit-error-recovery.sh:61`, `scripts/delegate-retry.sh:51` | Magic-3 circuit-breaker thresholds undocumented (rule violation) |
| L-6 | BUG | `scripts/delegate-retry.sh:11` | "No such tool available: Agent" exact-string detection brittle to platform error wording changes |
| L-7 | BUG | `scripts/bash-error-recovery.sh:13` | Classification regex `error.*compil` fence-post wrong (matches false positives, misses "compilation error:") |
| L-8 | BUG | `scripts/bash-error-recovery.sh:23-24`, `scripts/read-error-recovery.sh:19` | Direct `jq -n` instead of `emit_context` helper from common.sh |
| L-9 | BUG | `scripts/subagent-complete.sh:32` | `LAST_MSG_PREVIEW=$(echo "${LAST_MSG}" \| head -c 200)` — `echo` mangles backslashes; use `printf '%s'` |
| L-10 | BUG | `scripts/final-verification-evidence.sh:128` | `COMPLETE` computed but only used for one `-eq 0` check; replace with direct grep |
| L-11 | BUG | `scripts/final-verification-evidence.sh:121` | `[[ ${MARKER_AGE} -gt ${MAX_MARKER_AGE_SECONDS} ]]` fails on empty `MARKER_AGE` (corrupt marker) |
| L-12 | BUG | `scripts/task-completed-verify.sh` | `RECENT_EDITS` computed but only varies error message; either remove or use to change block decision |
| L-13 | BUG | `scripts/teammate-idle-guard.sh:20` | `OMCA_AGENT_TIMEOUT_SECS:-600` undocumented magic number |
| L-14 | BUG | `scripts/subagent-start.sh:18` | Hardcoded agent type list drifts from `agents/` inventory; new agents fall through to default. Make catch-all default safe |
| L-15 | BUG | `scripts/subagent-start.sh:139` | `AGENT_TYPE_SHORT` comment misleading about prefix-stripping semantics |
| L-16 | BUG | `scripts/track-subagent-spawn.sh:50` | `SESSION_STATE` assigned twice (lines 42 and 50); remove duplicate |
| L-17 | BUG | `scripts/keyword-detector.sh:9` | Comment claims "All hook payloads include agent_id"; contradicts hooks.md (only present inside subagent calls) |
| L-18 | BUG | `scripts/pre-compact.sh:34` | `tr -d '"'` strips quotes including ones inside agent prompts |
| L-19 | IMPL | `scripts/lifecycle-state.sh` | Document why this script is registered for WorktreeCreate when it's a no-op replacement of platform default; consider deregistering |
| L-20 | IMPL | `CLAUDE.md` user reference | Document `--plugin-dir` zip support, `--plugin-url`, `claude project purge`, `claude plugin tag/prune` (see §2.5 platform additions) |
| L-21 | IMPL | `scripts/lib/common.sh` | Document session-path encoding algorithm in comments (Agent SDK §10.8) |
| L-22 | IMPL | `CLAUDE.md` | Document `/ultrareview` complement to `oracle` agent; document `/fewer-permission-prompts` |
| L-23 | IMPL | `CLAUDE.md` | Document permission evaluation order (§8.1 5-step) |
| L-24 | IMPL | `CLAUDE.md`, statusline emitter | §6.5 statusline schema additions (`effort.level`, `thinking.enabled` in stdin) |

---

## Notable corrections from v1 review (preserved as historical note)

| v1 claim | Truth |
|---|---|
| `channels[]` field doesn't exist in `plugin.json` | It does (`plugins-reference.md:484-511`); manifest binds channel server with optional per-channel `userConfig` |
| `parentSettingsBehavior` is a misnomer | Real managed-settings field, v2.1.133+ (`settings.md:217`), values `"first-wins"`/`"merge"` |
| PreCompact / SessionEnd / PostCompact need to be added | Already registered in `hooks.json:269-298` |
| `output-styles/omca-default.md` is new work | Already exists (3-line body, no force-for-plugin); migration is augment-in-place |
| All OMCA skill descriptions are well under 250 chars | At least `consolidate-memory` is ~895 chars and silently truncated today |
| `alwaysLoad: true` is zero-risk | Blocks startup at 5s cap (`mcp.md:1194`); uv cold-start can approach this |
| `final-verification-evidence.sh` ignores session phase | Has extensive staleness short-circuits; bug is the narrower cross-session-ACTIVE_PLAN-without-MARKER gap (C-8) |
| `tengu_harbor` flag gates channels | Community-sourced claim, not in official docs |
| `OMCA_CONFIGURED=1` is an env var | Script-local variable in `session-init.sh:63` |
| Injection saves ~10K tokens/turn | Saves ~3K tokens per session-start |

---

## Top skips (out of scope for this work)

| Item | Why |
|---|---|
| Build an OMCA channel plugin | Research preview, "may change", Bun-leaning. Defer. |
| Hooks `type: "agent"` | Marked **experimental**; docs recommend `command` for production |
| Hooks `type: "http"` | Requires sidecar OMCA doesn't ship; `mcp_tool` covers same ground |
| Force-apply `Explanatory` output style | Wrong default for plan-execution sessions |
| Routines as plugin surface | User/account-level; OMCA skills auto-available without plugin change |
| Migrate to `Task*` deferred tools (replacing `TodoWrite`) | Deprecated SDK 0.2.136, no removal version. Watch trigger only |
| Build OMCA channel with `omca` MCP server | Would require sender allowlist mechanism not currently built |
| Custom themes | OMCA scope is orchestration, not branding |
| LSP plugin servers | OMCA isn't language tooling |
| **Output-style migration (Track 3 from prior plan)** | Per user decision: separate plan after this one ships |

---

## §1 — Hooks (detail)

### 1.1 Existing event registrations to audit/enhance

OMCA already registers `PreCompact`, `PostCompact`, `SessionEnd` (see `hooks.json:269-298`). v1 incorrectly framed these as new work.

**1.1.1 PreCompact** (`scripts/pre-compact.sh`): Audit for F1-F4-freshness gating during plan execution. Implementation if missing: read `.omca/state/boulder.json` and `.omca/state/pending-final-verify.json`; emit `{"decision":"block","reason":"..."}` only on narrow positive condition. **Depends on C-8 fix** (without it, the gate inherits the false-positive). [H-17]

**1.1.2 SessionEnd** (`scripts/session-cleanup.sh`): Audit for end-of-session sweep (stale state, expired markers, async backlog flush). [H-18]

**Other unregistered events**:
- `Elicitation`/`ElicitationResult` — defer; `omca` server doesn't use elicitation
- `PermissionDenied` — adopt-later (permissions-coach feature)
- `UserPromptExpansion` — defer; OMCA slash commands intentionally simple
- `PostToolBatch` — adopt-later (aggregate evidence flushing)

### 1.2 Hook handler types — `mcp_tool` migration (H-16)

OMCA uses only `type: "command"`. Migration target: `plan-checkbox-verify.sh` → `mcp_tool`.

**Gated by FastMCP block-shape prototype**:
1. Build minimal `validate_plan_write` MCP tool returning `{decision: "block", reason: ...}` shape.
2. Verify FastMCP supports it; verify platform `mcp_tool` handler honors it; verify `${tool_input.file_path}` and `${tool_input.content}` substitution works for both `Write` and `Edit`.
3. Paired commit: `hooks.json` entry replaced with mcp_tool entry; `scripts/plan-checkbox-verify.sh` deleted in same commit (no doubled validation).

`type: "agent"` is experimental — skip. `type: "http"` requires sidecar — skip. `type: "prompt"` cost-gated; opt-in semantic Stop complement only.

### 1.3 New hook input fields

| Field | Version | Action |
|---|---|---|
| `effort.level` + `$CLAUDE_EFFORT` | v2.1.132 | Document in `hook-scripts.md`; adopt selectively |
| `duration_ms` on PostToolUse/Failure | v2.1.119 | Document; no current adoption |
| `hookSpecificOutput.sessionTitle` on UserPromptSubmit | v2.1.94 | Adopt — set title to `OMCA: <plan-name>` during plan execution |
| `CLAUDE_CODE_SESSION_ID` | v2.1.132 | Bash/PowerShell tool subprocess only; NOT hook subprocess |

### 1.4 Behavior changes (no-action / audit-only)

- v2.1.98 visible-stderr in hook errors: **audit `tests/bats/`** for "stderr empty" assertions [H-21]
- `permissions.deny` no longer overridable by `ask` (v2.1.101): confirms `permission-filter.sh` design
- PostToolUse `updatedToolOutput` works on all tools (v2.1.121): document
- PreToolUse `additionalContext` retained on tool failure (v2.1.110): `context-injector.sh` benefits
- Async PostToolUse no-response empty-transcript fix (v2.1.119): OMCA hooks benefit

---

## §2 — Agents, Skills, Commands

### 2.1 Agent frontmatter `effort:` IS platform-parsed

Per `sub-agents.md:275`: `effort` field accepts `low|medium|high|xhigh|max`, overrides session level. **OMCA's `effort: max` correctly maps to platform `max`**. Document in `agent-conventions.md`.

### 2.2 Skill description cap raised 250 → 1,536 (v2.1.105) [H-14]

OMCA enforces 250 chars; at least one skill (`consolidate-memory` ≈ 895 chars) silently truncated. Update CLAUDE.md, `validate-plugin.sh`, and `agent-conventions.md`. Inventory and rewrite over-cap descriptions.

### 2.3 `skillOverrides` recommendation [H-23]

Per user direction: only `handoff` gets `user-invocable-only` mode. Other candidates rejected.

### 2.4 Worktree isolation default flip (v2.1.133) [H-19]

`worktree.baseRef` default `fresh` (branches from `origin/<default>`). v2.1.128 had defaulted to local `HEAD`. Worktree-isolation agents will NOT include unpushed commits unless user sets `worktree.baseRef: "head"`. Document in CLAUDE.md.

### 2.5 Other (document only)

- `--print`/`--agent` honor `tools:`/`disallowedTools:`/`permissionMode` (v2.1.119)
- Agent frontmatter `mcpServers` honored when `--agent` (v2.1.117)
- Subagent worktree access fix (v2.1.101): validate executor at depth 1 sees MCP tools
- Subagent stall 10-min timeout (v2.1.113)
- `claude plugin tag` (v2.1.118): tags `plugin.json` version only — keep `just release` as authoritative bumper
- New user-facing slash commands: `/ultrareview`, `/recap`, `/usage`, `/tui`, `/proactive`, etc. [L-20, L-22]

---

## §3 — Output style migration (active; subject of follow-up plan)

The output-style migration is now active work — the master-roster sweep is complete, and this section drives the follow-up plan.

**Decisions locked**:
- `force-for-plugin: true` with `disableForceOrchestrationStyle` userConfig opt-out
- Augment `omca-default.md` in place (single style file, not a second one)
- `keep-coding-instructions: true` (preserves Claude's default coding instructions)
- **Rollout: one-shot, no deprecation layer** — single release migrates the orchestration body to the output style and removes the existing `templates/claudemd.md` injection in `session-init.sh` simultaneously, plus removes the `OMCA_CONFIGURED` auto-detection branch
- **Body partition strategy**: verbatim move with section-table walkthrough (each section of `templates/claudemd.md` gets a disposition: verbatim into output-style body, condense, move to per-agent prompt, or delete because platform-owned now)

**Body partition (sections of `templates/claudemd.md`)**:
- `<operating_principles>` — verbatim into output-style body
- Delegation table — verbatim into output-style body
- `<entrypoints>` (slash command table) — trim to OMCA-orchestrated subset; drop user-only commands
- `<agent_catalog>` table — verbatim into output-style body
- `<workflow>` (Prometheus pipeline) — verbatim into output-style body
- `<critical_rules>` — verbatim into output-style body
- `<parallel_execution>` — verbatim into output-style body
- `<verification>` — verbatim into output-style body
- `<file_reading>` — verbatim into output-style body
- Target body size: ≤4K tokens.

**Surface (files affected by migration)**: `output-styles/omca-default.md` (rewrite body, add force-for-plugin), `.claude-plugin/plugin.json` (add `disableForceOrchestrationStyle` userConfig field), `scripts/session-init.sh` (remove injection branches and `OMCA_CONFIGURED` auto-detection), `templates/claudemd.md` (delete after migration), `CHANGELOG.md` (release-note entry), tests for rendered system prompt.

---

## §4 — MCP server tooling

### 4.1 `alwaysLoad: true` for `omca` (gated by bench) [H-15]

`alwaysLoad: true` blocks startup until server connects, capped 5s. uv cold-cache install can approach the cap. Bench cold/warm; if warm reliably <2s, adopt. May need unconditional uv-sync warmup in `session-init.sh`.

### 4.2 `workspace` is reserved (v2.1.128)

OMCA doesn't use it. Audit-complete. Document in MCP conventions to prevent future conflicts.

### 4.3 Audit `servers/` for stdout pollution [H-20]

v2.1.110 fixed a regression where stdio MCP servers printing non-JSON to stdout disconnected on first such line. FastMCP defaults to stderr. Audit custom prints.

### 4.4 Other MCP items

- MCP servers retry transient startup errors up to 3× (v2.1.121): no action
- `userConfig` adoption opportunities: per-feature audit when adding new configurable behavior
- `updatedMCPToolOutput` deprecated → `updatedToolOutput` (SDK 0.2.121): grep OMCA for usage

---

## §5 — OMCA hook bugs (full diagnosis + fix sketches)

### 5.1 `final-verification-evidence.sh` cross-session active_plan staleness [C-8]

**Symptom (live)**: F1-F4 demand fires on every Stop in this planning-interview session.

**Diagnosis**: lines 63-72 session-ID mismatch short-circuit only runs if `MARKER_PLAN` exists. When `ACTIVE_PLAN` is set in `boulder.json` from a prior session AND no MARKER exists in current session AND prior plan has all checkboxes `[x]`, the script falls through to the F1-F4 check.

**Reproduction**:
1. Session A runs `/start-work`, completes plan, all checkboxes `[x]`.
2. `boulder.json` retains `active_plan` pointing to it.
3. Session B (new) has no MARKER but inherits `active_plan` from boulder.
4. Stop fires → demand fires (incorrect).

**Fix sketch** (add after line 98):
```bash
# Cross-session ACTIVE_PLAN-without-MARKER short-circuit:
# active_plan from prior session is stale when no marker exists in this session.
if [[ -n "${ACTIVE_PLAN}" && -z "${MARKER_PLAN}" ]]; then
    log_hook_error "cleared cross-session stale active_plan reference (no marker)" "final-verification-evidence.sh"
    noop_exit
fi
```

**Acceptance criteria**: repro recipe no longer triggers demand; genuine plan execution (with MARKER) still triggers when F1-F4 missing. Tests in `tests/bats/hooks/final_verification.bats` cover both cases.

### 5.2 `keyword-detector.sh` echo false-positive [C-10]

**Symptom (live)**: RALPH/ULTRAWORK/HANDOFF/METIS injections re-fire on every system reminder containing the original-prompt keyword echoes.

**Root cause**: detector fires on any `additionalContext` containing the keyword pattern, not only on genuine UserPromptSubmit from the human.

**Fix**: gate on detection-already-active state. Once a mode is detected in a session, write a marker to `.omca/state/active-modes.json`. On subsequent fires, check the marker and skip re-announcement.

**Acceptance criteria**: first user prompt containing a mode keyword still announces; subsequent system-reminder echoes do not re-announce.

### 5.3 `notify.sh` field name [C-1]

```bash
# scripts/notify.sh:7 (current)
NOTIFICATION_TYPE=$(jq -r '.type // "notification"' <<< "${HOOK_INPUT}")
```

Platform input per `hooks.md:1584-1595`:
```json
{ "hook_event_name": "Notification", "message": "...", "title": "...", "notification_type": "permission_prompt" }
```

**Fix**: change `.type` → `.notification_type`. Also: lines 14, 18 trample platform-provided `.message` ("Claude needs your permission to use Bash") with hardcoded "Claude Code is waiting for your input"; pass-through OR generate context-specific (not both half-heartedly).

### 5.4 `lifecycle-state.sh` WorktreeRemove field name [C-2]

```bash
# scripts/lifecycle-state.sh:220 (current)
name=$(jq -r '.name // ""' <<< "${HOOK_INPUT}")
```

Platform sends `.worktree_path`, NOT `.name` (`hooks.md:2100-2112`). Hook always exits with "non-empty name required". `.omca/state/worktrees/` tracking files NEVER cleaned up.

**Fix**: read `worktree_path`; derive `name` from `basename` if needed for tracking-file rename pattern.

### 5.5 `empty-task-response.sh` field names + shape [C-3]

Two compounding errors:
1. `.tool_result` doesn't exist (canonical is `.tool_response`).
2. Agent's `tool_response` is structured object — reading as flat string captures JSON-stringified version including braces; `RESPONSE_LENGTH < 50` never true; transitional-text regex never matches.
3. `.agent_name`/`.subagent_type` at top level both null — canonical path is `.tool_input.subagent_type`. Case statement at line 34 always falls through.

**Fix**: rewrite to read `.tool_response` (object/string per tool — for Agent it's structured), inspect `.result` field if present, read `.tool_input.subagent_type` for agent-type detection.

### 5.6 `delegate-retry.sh` tool_name fallback [C-4]

```bash
# scripts/delegate-retry.sh:9
TOOL_NAME=$(jq -r '.tool_name // "Task"' <<< "${HOOK_INPUT}")
```

Matcher is `Agent` (per `hooks.json:185-191`). Platform tool name is `Agent`. Counter file gets `Task:delegate_error` keys while Agent-error trackers use `Agent:`. **Counter state silently fragmented**.

**Fix**: change fallback to `// "Agent"`. One-time migration in `session-init.sh` to merge `Task:` keys into `Agent:`.

### 5.7 `agent-usage-reminder.sh` SubagentStart race [C-5]

`active-agents.json` populated by `subagent-start.sh:128-133` (SubagentStart event). `track-subagent-spawn.sh:33` writes a different file (`subagents.json`). Race window: parent Grep call AFTER `track-subagent-spawn.sh` (PreToolUse Agent matcher) BUT BEFORE `subagent-start.sh` (SubagentStart) — agent-usage-reminder sees no active agents and over-prompts.

**Fix**: read whichever of the two files has the later mtime; OR consult both and union counts; OR use `concurrency_status` MCP tool.

### 5.8 `post-edit.sh` field name [C-6]

```bash
# scripts/post-edit.sh:10
TOOL_RESULT=$(jq -r '.tool_result.success // true' <<< "${HOOK_INPUT}")
```

Canonical is `.tool_response`. The `// true` always wins. `edits.jsonl` `success` constant `true`.

**Fix**: change `.tool_result.success` → `.tool_response.success`.

### 5.9 `write-guard.sh` contract decision [C-7]

PreToolUse `additionalContext` fires post-tool, not pre-tool. Messages worded as pre-write guidance. Hook does NOT return `permissionDecision: "deny"` — only emits context. Local `emit_context` shadows `common.sh` 2-arg version with 1-arg PreToolUse-only version.

**Fix — pick one**:
- **Block intent**: emit `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Manual writes to verification-evidence.json are forbidden. Use evidence_log MCP tool."}}`
- **Post-hoc nudge intent**: rephrase past tense ("Detected manual write to evidence file…"). Drop the local helper override.

### 5.10 `final-verification-evidence.sh:has_ftype` legacy fallback [C-9]

```jq
# scripts/final-verification-evidence.sh:149-163
.entries // []
| map(select(
    .type == $t
    and (... freshness check ...)
    and (
        ($sha == "")
        or (.plan_sha256 == $sha)
        or ((.output_snippet // "") | test("plan_sha256:" + $sha))
        or (.plan_sha256 == null or .plan_sha256 == "")    # ← THIS
    )
))
```

Fourth OR-clause means **any entry without first-class `plan_sha256` is accepted regardless of plan**. Same staleness vector C-8 closes via different path. SHA cross-check at lines 187-202 only queries legacy entries, missing modern entries.

**Fix**: drop the legacy-fallback OR clause; require either snippet match or first-class match. Update cross-check at 187-202 to query all F1-F4 entries (legacy + modern).

### 5.11 Recovery-script schema drift [H-1]

`bash-error-recovery.sh:7`, `read-error-recovery.sh:7`, `edit-error-recovery.sh:9`, `delegate-retry.sh:7`, `post-edit.sh`, `json-error-recovery.sh` read `.tool_error` or `.tool_result.error`. Neither documented in `hooks.md`. Canonical is just `.error`.

**Fix**: sweep all 6, replace with `.error`. Add `validate-plugin.sh` grep check failing CI on `tool_result\b` or `tool_error\b` references [M-25].

### 5.12 `permission-filter.sh` policy [H-2]

CLAUDE.md says guardrail-only; script auto-allows `npm/bun/yarn/pnpm/jq/uv`. Plus `sudo rm` regex dead (no `Bash(sudo *)` filter). Plus missing `if:` filters for `bun *`/`yarn *`/`pnpm *`.

**Decisions needed**: confirm guardrail-only stance (recommend) — narrow auto-allow OR remove. Add `Bash(sudo *)` filter. Add bun/yarn/pnpm registrations.

### 5.13-5.24 (compact)

Diagnoses for H-3 through H-22 + M-* are sketched in the master roster rows above. Detailed file:line + fix sketches available in the auditor outputs preserved at `/tmp/claude-1000/.../tasks/*.output` (transcripts not for re-reading; the roster row contains the actionable summary).

---

## §6 — Plugin schema, settings, env vars (compact)

### 6.1 Manifest field reference

Recognized top-level keys: `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `outputStyles` (declared), `userConfig` (declared with `enableKeywordTriggers`, `statuslineMode`), `channels` (NOT declared), `experimental.monitors`, `experimental.themes`, `mcpServers` (uses `.mcp.json` instead), `lsp` (skip), `hooks` (uses sibling `hooks/hooks.json`).

**Path behavior**: `commands`, `agents`, `outputStyles`, `experimental.themes`, `experimental.monitors` REPLACE defaults; `skills` ADDS to defaults.

### 6.2 Skill description cap [H-14]

Already covered in §2.2. Detail items:
- Update CLAUDE.md cap reference 250 → 1,536; recommend internal soft-cap ≤512 chars
- Update `validate-plugin.sh` enforcement
- Inventory all `skills/*/SKILL.md` over 250; rewrite where can be tightened

### 6.3 Settings new fields (document)

- **Sandbox/permissions**: `autoMode.hard_deny` (v2.1.132), `autoMode.allow/.soft_deny/.environment` accept `"$defaults"` (v2.1.118), `sandbox.network.deniedDomains` (v2.1.113), `parentSettingsBehavior` (v2.1.133, real field, `"first-wins"`/`"merge"`)
- **Auth**: `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_PERFORCE_MODE`, `CLAUDE_CODE_CERT_STORE`, `forceLoginMethod`, `forceLoginOrgUUID`
- **Cosmetic/perf**: `refreshInterval`, `effortLevel`, `outputStyle`, `tui`, `prUrlTemplate`, `CLAUDE_CODE_HIDE_CWD`, `ENABLE_PROMPT_CACHING_1H`, `ANTHROPIC_BEDROCK_SERVICE_TIER`, `CLAUDE_CODE_*` (gateway/sync/etc.), `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`
- **CLI**: `--exclude-dynamic-system-prompt-sections`, `DISABLE_UPDATES`, `wslInheritsWindowsSettings`, `--plugin-dir` zip, `--plugin-url`

### 6.4 Permission/sandbox tightening (document)

`Bash(find:*)` no longer auto-approves `-exec`/`-delete` (v2.1.113); deny rules match through `env`/`sudo`/`watch`/`ionice`/`setsid` wrappers (v2.1.113); sandbox auto-allow dangerous-path enforcement (v2.1.116); `--dangerously-skip-permissions` no longer prompts on protected paths (v2.1.126); PowerShell auto-approvable (v2.1.119); `allowManagedDomainsOnly`/`allowManagedReadPathsOnly` enforcement (v2.1.126).

### 6.5 Statusline schema additions [L-24]

v2.1.97: `refreshInterval`. v2.1.119: `effort.level`+`thinking.enabled` in stdin. Audit OMCA statusline emitter against new schema.

---

## §7 — Tracks 1-6 deferrable items

**Already adopted in master roster**: H-15 alwaysLoad, H-16 mcp_tool migration, H-17 PreCompact audit, H-18 SessionEnd audit, H-19 worktree.baseRef, H-20 servers stdout audit, H-21 bats stderr audit.

**Adopt-later prototypes** (after main sweep lands):
- Monitor for evidence-log streaming
- Semantic Stop complement (`type: prompt`) opt-in
- Permission-denied coach hook
- `agent_id` recording in subagent state hooks (per metis GH-3 from earlier review)

**Watch triggers**:
- `TodoWrite` deprecation gains removal version → escalate sisyphus migration
- `Skill` in `allowedTools` deprecation gains removal version → audit
- `worktree.baseRef` user reports of unpushed-commit surprise → document more loudly

---

## §8 — Cross-feature interactions

**Output style × `skillOverrides` × `keep-coding-instructions`** (out of scope this plan; relevant to future Track 3): rendered system prompt order: default coding instructions (because `keep-coding-instructions: true`) + output-style body + skill descriptions filtered by `skillOverrides` + agent prompts.

**`alwaysLoad` × ToolSearch × first-turn headless**: `alwaysLoad: true` skips ToolSearch deferral but tools stay searchable. v2.1.105 fixed first-turn-headless availability.

**PreCompact × ralph-persistence × final-verification-evidence**: H-17 PreCompact enhancement inherits C-8 false-positive if C-8 isn't fixed first. **Bug fixes precede enhancement.**

**SessionEnd × Stop × ralph mode**: Stop fires per-turn; SessionEnd fires on session termination. Ralph-mode session ending by `clear`: each turn `Stop` fires (ralph decides continue/stop); session terminates → `SessionEnd` fires. `session-cleanup.sh` should NOT cancel ralph state before ralph itself finalizes.

---

## §9 — Risk register

| Risk | Likelihood | Impact | Mitigation | Roster row |
|---|---|---|---|---|
| `mcp_tool` migration fails (FastMCP can't return block-shape) | Medium | High | Prototype gate; abandon if fails | H-16 |
| `alwaysLoad: true` startup timeout on cold uv | Medium | High | Bench gate; warmup mitigation | H-15 |
| `final-verification-evidence` fix over-suppresses | Low | High | Repro test covers stale (no demand) and genuine (demand) | C-8 |
| `keyword-detector` fix breaks genuine first-fire | Low | Medium | Repro test covers both cases | C-10 |
| Skill description rewrites break model triggering | Low | Medium | Spot-test each rewritten description | H-14 |
| Recovery-script schema sweep misses an instance | Low | High | `validate-plugin.sh` grep check (M-25) prevents future drift | H-1, M-25 |
| `permission-filter.sh` policy decision affects existing user workflows | Medium | Medium | Decide guardrail-only OR document existing auto-allow scope | H-2 |
| Output-style migration deferred → `OMCA_CONFIGURED` branch persists | Low | Low | Out of scope; separate plan | n/a |

---

## Appendix A — Per-version timeline (compact)

[Spans v2.1.94 through v2.1.133. Versions with no plugin-author-relevant changes (v2.1.96, v2.1.107, v2.1.109, v2.1.112, v2.1.123, v2.1.131) are IDE-only or cosmetic.]

| Version | Notable changes |
|---|---|
| v2.1.94 | `hookSpecificOutput.sessionTitle`; `keep-coding-instructions`; `"skills": ["./"]` uses frontmatter name; plugin skill frontmatter hooks fire |
| v2.1.97 | `refreshInterval` status line; `workspace.git_worktree`; long-session prompt-hook fix; MCP HTTP/SSE memory leak fix |
| v2.1.98 | Bash permission hardening; `--exclude-dynamic-system-prompt-sections`; `CLAUDE_CODE_PERFORCE_MODE`; agent-teams permission inheritance fix; **stderr first-line in hook errors without `--debug`**; Monitor tool added |
| v2.1.101 | `permissions.deny` security fix; subagent worktree access fix; subagents inherit MCP tools from dynamically-injected servers; OS CA store trusted by default |
| v2.1.105 | **`PreCompact` hook**; **skill description cap 250 → 1,536**; plugin `monitors` manifest key; MCP tools missing on first headless turn fix |
| v2.1.108 | `/recap`; `ENABLE_PROMPT_CACHING_1H`; built-in slash commands invocable via Skill |
| v2.1.110 | `PermissionRequest` `updatedInput` re-checked; `PreToolUse.additionalContext` retained on tool failure; **MCP stdio non-JSON disconnect regression fix**; HTTP/SSE drop hang fix |
| v2.1.111 | `/ultrareview`; `xhigh` effort level; plan files use prompt slug; auto-mode no longer requires flag |
| v2.1.113 | Native binary distribution; subagent stall 10-min timeout; `Bash(find:*)` no longer auto-approves -exec/-delete; Bash deny match through wrappers; `sandbox.network.deniedDomains` |
| v2.1.116 | Agent frontmatter `hooks:` fire when `--agent`; sandbox auto-allow dangerous-path enforcement |
| v2.1.117 | Agent frontmatter `mcpServers` honored when `--agent`; Opus 4.7 1M-window fix; `CLAUDE_CODE_FORK_SUBAGENT=1` |
| v2.1.118 | **`type: "mcp_tool"` hook handler**; custom themes; `claude plugin tag`; `wslInheritsWindowsSettings`; SDK `managedSettings` |
| v2.1.119 | `duration_ms`; status line `effort.level`+`thinking.enabled`; `--print`/`--agent` honor agent frontmatter; `prUrlTemplate`; **async PostToolUse no-response empty-transcript fix** |
| v2.1.120 | Skills can use `${CLAUDE_EFFORT}`; `claude ultrareview [target]`; `Skill` in `allowedTools` deprecated |
| v2.1.121 | **`alwaysLoad: true` for MCP servers**; `claude plugin prune`; multi-GB memory leaks fixed; MCP transient-startup retry |
| v2.1.122 | OTel numeric attrs (BREAKING for parsers); `claude_code.at_mention`; `ANTHROPIC_BEDROCK_SERVICE_TIER` |
| v2.1.126 | `claude project purge`; deferred tools to `context: fork` skills first turn fix; `claude auth login` accepts terminal-paste OAuth |
| v2.1.128 | `--channels` works with console auth; `--plugin-dir` zip; **`workspace` reserved MCP server name** |
| v2.1.129 | `--plugin-url`; themes+monitors moved under `experimental:`; `skillOverrides` setting functional; `OTEL_*` no longer inherited by subprocesses |
| v2.1.132 | `effort.level` in all hook inputs + `$CLAUDE_EFFORT`; `CLAUDE_CODE_SESSION_ID` in Bash/PowerShell subprocess; `autoMode.hard_deny`; MCP servers silent-disappear-after-`/clear` fix |
| v2.1.133 | **`parentSettingsBehavior` admin key**; **`worktree.baseRef` setting**; v2.1.128 `EnterWorktree` local-`HEAD` default reverted |

---

## Appendix B — Hook handler-type matrix

| Event | command | http | mcp_tool | prompt | agent |
|---|---|---|---|---|---|
| SessionStart, Setup | YES | NO | YES | NO | NO |
| UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PostToolUse/Failure, PostToolBatch, Stop, SubagentStop, TaskCreated, TaskCompleted | YES | YES | YES | YES | YES |
| PermissionDenied | YES | YES | YES | NO | NO |
| TeammateIdle, SubagentStart, Notification, ConfigChange, CwdChanged, FileChanged, InstructionsLoaded, PreCompact, PostCompact, Elicitation, ElicitationResult, SessionEnd, StopFailure, WorktreeCreate, WorktreeRemove | YES | YES | YES | NO | NO |

---

## Appendix C — Source citations for resolved contradictions

| Claim | Source | Confidence |
|---|---|---|
| `channels[]` field exists in `plugin.json` | `plugins-reference.md:484-511` | High |
| `parentSettingsBehavior` is real, v2.1.133+, `"first-wins"`/`"merge"` | `settings.md:217` | High |
| `alwaysLoad` blocks startup at 5s cap | `mcp.md:1194` | High |
| `force-for-plugin` overrides user's `outputStyle` | `output-styles.md:107` | High |
| `final-verification-evidence.sh` has session-aware short-circuits | `scripts/final-verification-evidence.sh:28-92` | High (direct read) |
| PreCompact/PostCompact/SessionEnd already registered | `hooks/hooks.json:269-298` | High (direct read) |
| Agent frontmatter `effort:` is platform-parsed (`low/medium/high/xhigh/max`) | `sub-agents.md:275` | High |
| `CLAUDE_CODE_SESSION_ID` is in Bash/PowerShell tool subprocesses ONLY | `env-vars.md:142` | High |
| `claude plugin tag` tags `plugin.json` version (not the four files) | `plugins-reference.md:880-895` | High |
| `tengu_harbor` GrowthBook flag claim | Community GitHub issues | **Low (not in official docs)** |
| Bun runtime required by first-party channel plugins | `anthropics/claude-plugins-official` source review | High |
| Notification field is `.notification_type` (not `.type`) | `hooks.md:1584-1595` | High |
| WorktreeRemove sends `.worktree_path` (not `.name`) | `hooks.md:2100-2112` | High |
| PostToolUse field is `.tool_response` (not `.tool_result`) | `hooks.md:1346` | High |
| PostToolUseFailure field is `.error` (not `.tool_error`/`.tool_result.error`) | `hooks.md:1417` | High |
| Agent tool `subagent_type` is at `.tool_input.subagent_type` (not top level) | `hooks.md:1144` | High |

---

**End of report.** Total in-scope items: 85 (10 critical + 23 high + 28 medium + 24 low). Output-style migration (~10 sub-tasks) is out of scope, slated for a separate plan after this one ships.
