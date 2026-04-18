# OMCA v1.6.0 Upgrade — Planned, Not Yet Executed

**Status**: Plan fully drafted, reviewed, and approved. Execution deferred — not running today. Resume instructions below.

**Scope**: Align oh-my-claudeagent (OMCA v1.5.2) with Claude Code platform updates v2.1.92–v2.1.112. Adopt 4 new plugin primitives (`monitors/`, `channels`, expanded `userConfig`, `bin/`), hybrid plan-file backup, per-skill description tuning, 4 doc-drift repairs, low-risk hook improvements, and stale-state hook gating. ~55 atomic tasks across 11 groups.

**Plan file (canonical)**: `/home/utsav/.claude/plans/agile-chasing-lantern.md` — this UPGRADE.md mirrors its content.

---

## How to Resume (when ready to execute)

The plan is in the native plan-mode file. When you're ready, start atlas execution:

```
/oh-my-claudeagent:start-work
```

or explicitly:

```
/oh-my-claudeagent:atlas /home/utsav/.claude/plans/agile-chasing-lantern.md
```

Atlas will execute Wave 1 → Wave 6 as specified below. It is the ONLY agent authorized to touch the plan during execution — the main session must not implement tasks directly (per OMCA `operating_principles.3` in `~/.claude/CLAUDE.md`).

**Pre-flight sanity checks before resuming**:
1. Confirm `/home/utsav/.claude/plans/agile-chasing-lantern.md` still exists. If it was cleared, this UPGRADE.md is the recovery source — copy the "The Plan" section below to the plan-file path.
2. Check `.omca/state/boulder.json` — if `active_plan` points somewhere else, atlas may reject this plan. Clear via `mcp__plugin_oh-my-claudeagent_omca__mode_clear` or run `/oh-my-claudeagent:stop-continuation` before invoking atlas.
3. Confirm `claude-code-docs` local mirror is up-to-date at `/home/utsav/dev/softs/claude-code-docs/` (plan Group F.1 diagnosis + xhigh verification may re-reference platform docs).

---

## Session Timeline (how the plan was produced)

### Phase 0 — Discovery (2026-04-17)
User pulled `claude-code-docs` mirror ahead ~600 commits spanning Claude Code v2.1.92 → v2.1.112 (weeks 13–15 of 2026). Asked for a thorough review of what OMCA should adopt, fix, refactor, or clean up. Explicitly requested Oracle consultation and "ultrathink" rigor.

### Phase 1 — Prometheus exploration (depth 0, direct reads)
- Read new/changed docs: `plugins-reference.md`, `plugin-dependencies.md` (new), `hooks.md` (heavy expansion), `sub-agents.md`, `skills.md`, `agent-teams.md`, `routines.md` (new), `changelog.md`, `whats-new__2026-w15.md`
- Read current OMCA state: `plugin.json`, `hooks/hooks.json`, 13 agents, skills tree, `CLAUDE.md`, `OMCA.md`
- Drafted 8 BLOCKING QUESTIONS covering scope, plan-filename strategy, audit depth, capabilities, effort semantics, behavioral appetite, momus timing

### Phase 2 — Oracle strategic review
Oracle reviewed the 8 questions against OMCA's declared architecture ("Claude-native owns platform, OMCA owns orchestration policy"). Key findings:
- **Recommended Minimal scope** — argued Large scope risks violating OMCA's own ownership-split principle (monitors = scheduling = Claude-native territory; channels already explicitly disclaimed in `OMCA.md:30`)
- **Found 4 doc-drift gaps Prometheus missed**: OMCA.md vs prometheus.md contradiction on plan location; CLAUDE.md 250-char vs platform 1,536 skill cap; hook event count drift; managed-settings list divergence between OMCA.md and CLAUDE.md
- **Reframed Q2** from A/B/C options into a "which doc is authoritative" decision — answer: native path, per prometheus.md
- Verdict: "Short effort" with the reduced scope. Strongly cautioned against Large.

### Phase 3 — User decisions (via AskUserQuestion, 2 rounds)

Round 1:
| Q | User answer |
|---|---|
| Scope | **Large (adopt capabilities)** — OVERRODE Oracle's minimal recommendation |
| Plan files | Hybrid: native authoritative, `.omca/plans/` as backup (user-written custom answer, improved on Oracle's C option) |
| Audits | Oracle full package — skills + stale refs + drift repairs |
| Momus timing | After task lines written |

Round 2 (conditional on Large scope):
| Q | User answer |
|---|---|
| Capabilities to adopt | monitors + userConfig + channels + bin/ |
| Lower-value capabilities (deps/LSP/routines) | None — skip all |
| xhigh effort level | Verify semantics first |

### Phase 4 — Parallel Plan agents
Two Plan agents ran in parallel (background):
- **Plan Agent 1** designed Groups 1–5 (capability adoption + hybrid plan-file)
- **Plan Agent 2** designed Groups A–E (audits + drift repairs + hook tweaks + xhigh verification)

Key Plan Agent 2 finding: `xhigh` sits BETWEEN `high` and `max` (not above), per `changelog.md:18,20` and `sub-agents.md:245`. Not a rename of `max`. Decision locked: keep `effort: max` on oracle.md with rationale comment.

### Phase 5 — Orchestrator adds Group F
During this drafting session, two hooks fired spuriously:
- `final-verification-evidence.sh` demanded F1–F4 evidence despite no atlas execution
- `ralph-persistence.sh` reported "Active work plan detected via boulder" from a PRIOR session's stale state

These are real symptoms of a stale-state problem. Added **Group F: Stale-state hook firing** to address.

### Phase 6 — Momus review iterations (3 rounds)

**Iteration 1 — REJECT (4 BLOCKING)**:
1. F.1 proposed a phantom `CLAUDE_PLAN_MODE` env var that doesn't exist in the platform
2. Task 5.3 `matcher: Write|Edit` + `if: "Write(.claude/plans/*.md)"` — the `if:` filter only matches Write events, silently excluding Edit → incremental plan updates break
3. Group A.2 skill-cap decision marked "Open for Atlas" but gates Wave 3 work → mid-execution deadlock
4. Group 2 missing localhost-binding + port-conflict spec → silent multi-session collision

**Iteration 2 — REJECT (3 follow-up BLOCKING)**:
1. bridge.py stale state-file startup policy unspecified (what if prior crashed bridge left state file?)
2. `channel-forward.sh` default port 8789 contradicts ephemeral-fallback in 2.2
3. F.2 writer list "agents/atlas.md workflow" too vague for atlas to resolve

Plus 2 advisory items on ordering + plan-file-readonly clarification.

**Iteration 3 — OKAY (HIGH confidence)**:
All fixes landed; 2 trivial advisory tweaks applied (O_EXCL atomic create for state file, Wave 3 ordering clarification for Group F).

### Phase 7 — ExitPlanMode (user approved)
Plan approved with `allowedPrompts` scoped to: `just ci/lint/test`, `validate-plugin.sh`, `shellcheck`, `uv` for Python, `jq`/`grep` for verification, `chmod +x`, `git status/diff/log` (no commits without explicit request).

### Phase 8 — Post-approval user corrections
After approval, user tightened two decisions:

**Correction 1: Skill-cap — no blanket**
> "Skill-cap value needs to be updated for each and every single skill individually, do not select a random 500 value"

Group A restructured:
- Removed the locked 500-char decision
- A.2 decomposes into N sub-tasks (one per skill) for parallel fan-out
- Validator enforces only platform cap 1,536 (no OMCA-stylistic sub-cap)
- Each skill's description tuned to its own minimum-effective length for trigger accuracy

**Correction 2: Channels — opt-in AND verify**
> "Channels only if user enabled it during omca-setup and verified it to be working, otherwise disabled"

Group 2 restructured:
- Three-gates architecture (notifyChannel != off + Phase 6 completed + verification success)
- bridge.py runs in **inert mode** until all gates pass — no port bind, no credentials, no delivery
- New **2.10** Phase 6 in omca-setup: collects credentials in-memory, runs verify, persists ONLY on success
- New **2.11** `scripts/channel-verify.sh`: verification helper (Telegram API / Slack webhook)
- New **2.12** `omca-setup --doctor` re-verifies when channels enabled

### Phase 9 — Feedback memories saved
Two feedback patterns persisted to agent memory for future sessions:
- `feedback_no_blanket_caps.md` — per-item tuning over OMCA-chosen blanket caps
- `feedback_channels_opt_in_verify.md` — inert-by-default + verification before credential persistence

---

## Spurious Hook Notes

During this session, these hooks fired false-positives due to stale state artifacts:
- `final-verification-evidence.sh` ← fires when boulder has `active_plan` + INCOMPLETE>0, even during plan-drafting
- `ralph-persistence.sh` ← fires when boulder has `active_plan`, regardless of current-session context

**Before resuming**, consider running `/oh-my-claudeagent:stop-continuation` to clear any lingering boulder/ralph state — otherwise the same hooks may false-fire in the next session.

This is the exact problem **Group F** in the plan is designed to diagnose-then-fix.

---

## The Plan (canonical copy)

# OMCA v1.5.2 → Claude Code v2.1.92–v2.1.112 Plugin Alignment + Capability Adoption

## TL;DR
Align oh-my-claudeagent (OMCA) with Claude Code platform updates through v2.1.112. Scope confirmed by user as **Large**: adopt 4 new plugin primitives (monitors/, channels, expanded userConfig, bin/), implement hybrid plan-file backup (native authoritative + `.omca/plans/` mirror), per-skill description tuning (no blanket cap), stale-reference scrub, 4 doc-drift repairs, low-risk hook improvements, and gate spurious plan-mode hook firings. **Channels are opt-in with verification** — inert by default until user completes omca-setup Phase 6 AND verification ping succeeds. One new v1.6.0 release when complete. ~55 atomic tasks across 11 groups.

## Context

### Why this plan exists
User pulled the `claude-code-docs` mirror ahead by ~600 commits spanning Claude Code releases v2.1.92 to v2.1.112 (weeks 13–15 of 2026). OMCA is stable at v1.5.2 but the platform added five new primitives, renamed/retired surfaces OMCA referenced, and evolved semantics around effort levels, hook events, and plan-file naming. Goal: ship a deliberate adoption of the new primitives that fits OMCA's declared architecture ("Claude-native owns platform, OMCA owns orchestration policy"), not a blind upgrade.

### Prior consultations
- **Oracle** reviewed 8 scoping questions. Recommended minimal scope + specific drift-repairs; flagged 4 doc contradictions Prometheus missed.
- **User overrode Oracle on scope** — picked Large (adopt capabilities) rather than Oracle's minimal recommendation. Hybrid Q2 answer ("native authoritative, `.omca/plans/` backup") extended Oracle's A→C range into a recovery-tolerant design.
- **Plan agent 1** designed capability adoption (Groups 1–5).
- **Plan agent 2** designed audits + drift-repair + hook improvements + xhigh verification (Groups A–E).

### User decisions (locked)
| Question | Decision |
|---|---|
| Scope | **Large** — adopt new capabilities |
| Plan files | **Hybrid**: native authoritative, `.omca/plans/` auto-mirrored backup, `boulder.json` → native |
| Audits | **Oracle full package** — 21 skills + stale refs + 4 doc-drift fixes |
| Capabilities | **monitors + userConfig + channels + bin/** (skip deps/LSP/routines) |
| xhigh | **Verify first** — verification done by Plan Agent 2 |
| Momus | **Final plan review** (after task lines written) |

### xhigh verification result (Plan Agent 2 finding)
Per `changelog.md:18,20` and `sub-agents.md:245`: `xhigh` is a NEW Opus-4.7-only level sitting BETWEEN `high` and `max` (not above). Non-Opus-4.7 models fall back to `high`. `max` is NOT deprecated. **Decision: keep `effort: max` on oracle.md** with a rationale comment. Rejected alternatives documented.

### Observed session issue (additional Group F)
During this plan-drafting session, two hooks fired spuriously:
- `final-verification-evidence.sh` demanded F1–F4 evidence even though no atlas execution was happening.
- `ralph-persistence.sh` reported an active work plan from a prior session, blocking the Stop hook.

Both hooks key on presence of state artifacts, not on whether atlas is actually executing the current session. This is a concrete Large-scope improvement opportunity (Group F).

## Work Objectives

### Core Objective
Adopt 4 new platform primitives and reconcile OMCA's internal doc contradictions to land v1.6.0, preserving all current behavior by default and keeping OMCA on its declared side of the "Claude-native owns platform, OMCA owns orchestration" line.

### Must Have
- v1.6.0 release with `monitors/`, `channels` (opt-in + verified), expanded `userConfig`, and `bin/omca-*` all shipped
- Hybrid plan-file strategy working end-to-end: native writes auto-mirrored to `.omca/plans/`, `start-work` recovers from backup when native is missing
- All 4 Oracle-identified doc-drift repairs applied
- **Every skill individually tuned**: no blanket OMCA cap; validator enforces only platform's 1,536-char combined limit; each skill's `description`/`when_to_use` is the minimum-effective length for its own trigger accuracy
- **Channels inert-by-default**: bridge does not bind, does not request credentials, does not deliver until user completes `omca-setup` Phase 6 AND `channel-verify.sh` returns success. Failed verification discards credentials without persistence.
- Plan-mode hook gating so `final-verification-evidence.sh` and `ralph-persistence.sh` don't false-positive during drafting
- All new userConfig keys opt-in (defaults preserve v1.5.2 behavior)
- Every task has a concrete verification command; all builds green

### Must NOT Have (Guardrails)
- No adoption of plugin `dependencies`, `lspServers`, or cloud `routines` (user declined)
- No breaking changes to `.omca/state/` schema (boulder, notepad, evidence, ralph-state, ultrawork-state)
- No change to existing agent frontmatter patterns (`disallowedTools:`, `memory: project`, `isolation: worktree`)
- No removal of existing userConfig keys (`enableKeywordTriggers`, `statuslineMode`, `defaultOrchestrator`)
- No Python runtime dependency introduced outside `servers/` subtree
- No `bin/` executable without the `omca-` prefix (no PATH pollution)
- No channel integration that uses permission-relay capability (one-way only)
- No plan-file edits outside this active plan file during plan mode
- No skipping of momus review (user chose Q8=C)

## Verification Strategy
- **Test Decision**: Tests-alongside for new capabilities (each new script/bridge gets a bats test); manual verification for interactive paths (monitors, channels outbound, bin/ CLI)
- **Framework**: `just lint`, `just fmt-check`, `just test-hooks`, `just test-bats`, `just test-mcp`, `bash scripts/validate-plugin.sh`, `just ci`
- **Evidence**: Every verification run logged via `evidence_log` MCP tool per CLAUDE.md rule
- **Staged merge**: Groups land in dependency order (3 → 1+5+A+B+C+D+E+F in parallel → 2 → 4)

---

## Groups

### Group 3: `userConfig` expansion (FOUNDATIONAL — MUST LAND FIRST)

**Goal**: Declare 7 new user-tunable keys so downstream groups have their config surface; every default preserves current OMCA behavior.

**New keys**:

| Key | Type | Default | Consumer | Behavior |
|---|---|---|---|---|
| `ralphMaxIters` | integer | `0` (unlimited) | `scripts/ralph-persistence.sh` | When >0, allow stop at N stagnation iterations |
| `evidenceStrict` | boolean | `false` | `scripts/task-completed-verify.sh` | Disable keyword softening; always require fresh evidence |
| `notifyChannel` | enum (`off\|telegram\|slack`) | `off` | Group 2 bridge | Selects channel backend |
| `boulderBackupEnabled` | boolean | `true` | Group 5 mirror hook | False disables `.omca/plans/` mirror |
| `xhighEnabled` | boolean | `false` | (reserved for future opt-in) | Not wired in v1.6.0 — placeholder for future agent effort routing |
| `telegramBotToken` | sensitive string | unset | Group 2 bridge | Stored in platform keychain |
| `telegramChatId` | string | unset | Group 2 bridge | Outbound chat ID |

**Tasks**:
- [ ] 3.1 Extend `.claude-plugin/plugin.json` `userConfig` with the 7 keys — Verify: `jq '.userConfig | has("ralphMaxIters") and has("evidenceStrict") and has("notifyChannel") and has("boulderBackupEnabled") and has("xhighEnabled") and has("telegramBotToken") and has("telegramChatId")' .claude-plugin/plugin.json` returns `true`; existing keys (`enableKeywordTriggers`, `statuslineMode`, `defaultOrchestrator`) still present via `jq '.userConfig | has("enableKeywordTriggers")' ...` returns `true`
- [ ] 3.2 Mirror non-sensitive defaults into `settings.json` under `pluginConfigs."oh-my-claudeagent@omca".options` — Verify: `jq '.pluginConfigs["oh-my-claudeagent@omca"].options | keys' settings.json` contains new keys
- [ ] 3.3 Edit `scripts/ralph-persistence.sh`: read `CLAUDE_PLUGIN_OPTION_RALPHMAXITERS`; when >0 and stagnation_count >= N, allow stop — Verify: `shellcheck scripts/ralph-persistence.sh`; new bats case
- [ ] 3.4 Edit `scripts/task-completed-verify.sh`: when `CLAUDE_PLUGIN_OPTION_EVIDENCESTRICT=true`, bypass keyword-aware softening — Verify: new bats scenario; existing tests still pass
- [ ] 3.5 Update `skills/omca-setup/SKILL.md` Phase 5.5 and DOCTOR MODE Check 6 to inventory new keys — Verify: `grep -c 'ralphMaxIters\|evidenceStrict\|boulderBackupEnabled\|xhighEnabled' skills/omca-setup/SKILL.md` >=4
- [ ] 3.6 Add bats tests `tests/bats/user_config/keys.bats` — each default preserves current behavior — Verify: `just test-bats -- tests/bats/user_config/`
- [ ] 3.7 Update `templates/claudemd.md` noting new user-tunable knobs — Verify: `grep -c 'ralphMaxIters' templates/claudemd.md` >=1

**Risks**: env-var injection is uppercased; keychain ~2KB limit is fine for a single Telegram token; existing consumers (`enableKeywordTriggers`, `statuslineMode`, `defaultOrchestrator`) must not regress.

---

### Group 1: `monitors/` — stall & drift detection

**Goal**: Surface ralph/ultrawork stalls and agent-pool drift passively, via stdout-as-notification.

**New files**:
- `monitors/monitors.json` — declarative monitor list
- `scripts/monitor-ralph-stall.sh` — tails `.omca/logs/hook-errors.jsonl` for stagnation markers
- `scripts/monitor-ultrawork-idle.sh` — 30s polls `.omca/state/subagents.json` + `ultrawork-state.json`

**Tasks**:
- [ ] 1.1 Create `monitors/monitors.json` with `ralph-stall-watch` + `ultrawork-pool-idle` entries per schema in `/home/utsav/dev/softs/claude-code-docs/docs/plugins-reference.md` (monitors section) — each entry: `name`, `command` (`${CLAUDE_PLUGIN_ROOT}/scripts/monitor-*.sh`), `description`, `when: "always"` — Verify: `jq '. | length' monitors/monitors.json` returns 2; `jq '.[0] | has("name") and has("command") and has("description") and has("when")' monitors/monitors.json` returns `true`
- [ ] 1.2 Create `scripts/monitor-ralph-stall.sh` — `inotifywait -m` preferred, `tail -F` fallback for macOS; emit `[MONITOR] ralph stall: <reason>` lines; sleep-floor 30s — Verify: `shellcheck scripts/monitor-ralph-stall.sh`
- [ ] 1.3 Create `scripts/monitor-ultrawork-idle.sh` — 3 consecutive idle polls triggers emit — Verify: `shellcheck scripts/monitor-ultrawork-idle.sh`
- [ ] 1.4 `chmod +x` both monitor scripts — Verify: `test -x scripts/monitor-ralph-stall.sh && test -x scripts/monitor-ultrawork-idle.sh`
- [ ] 1.5 Add `"monitors": "./monitors/monitors.json"` to `.claude-plugin/plugin.json` — Verify: `jq -r '.monitors' .claude-plugin/plugin.json` returns the path
- [ ] 1.6 Add "Monitors" subsection to `OMCA.md` Core Concepts — stdout-as-notification, `when: always`, interactive-CLI-only limitation — Verify: `grep -c '^### Monitors' OMCA.md` >=1
- [ ] 1.7 Add `tests/bats/monitors/monitor_scripts.bats` — exits cleanly with missing state; emits expected prefix — Verify: `just test-bats -- tests/bats/monitors/`

**Risks**: macOS lacks `inotifywait` by default; CPU leak via busy loop if sleep-floor skipped; monitors skipped in `-p` mode (document).

---

### Group 5: hybrid plan-file backup

**Goal**: Native `.claude/plans/<name>.md` is authoritative; `.omca/plans/<name>.md` is auto-mirrored backup; `start-work` recovers from backup when native is lost.

**New files**:
- `scripts/plan-mirror.sh` — PostToolUse Write|Edit hook. Gates on path match + `BOULDERBACKUPENABLED` userConfig **entirely inside the script** (no `if:` filter). Atomic copy via `tmp+mv` with `cp` fallback for cross-filesystem.

**Momus fix (applied)**: Original task 5.3 proposed `matcher: Write|Edit` + `if: "Write(.claude/plans/*.md)"`. The `if:` field uses per-tool permission-rule syntax and would ONLY match Write events, silently excluding Edit — breaking incremental plan updates. Resolution: **drop `if:` entirely; perform path match and userConfig gate inside `plan-mirror.sh`** using `tool_input.file_path` from stdin JSON. Performance cost is a few script invocations per turn (acceptable for async hook).

**Tasks**:
- [ ] 5.1 Create `scripts/plan-mirror.sh` — read stdin JSON via `INPUT=$(cat)`, extract `file_path=$(jq -r '.tool_input.file_path' <<<"$INPUT")`; if not matching `.claude/plans/*.md`, exit 0 silently; if `CLAUDE_PLUGIN_OPTION_BOULDERBACKUPENABLED` is literally `false`, exit 0; else atomic copy to `${CLAUDE_PROJECT_ROOT}/.omca/plans/$(basename $file_path)` via `tmp+mv` (with `cp` fallback for cross-filesystem) — Verify: `shellcheck scripts/plan-mirror.sh`; synthetic stdin test — pipe `{"tool_input":{"file_path":".claude/plans/foo.md"}}` in, assert mirror written; pipe `{"tool_input":{"file_path":"unrelated.md"}}` in, assert no mirror
- [ ] 5.2 `chmod +x scripts/plan-mirror.sh` — Verify: `test -x scripts/plan-mirror.sh`
- [ ] 5.3 Register in `hooks/hooks.json` under `PostToolUse`, **matcher `"Write|Edit"` only — NO `if:` field**, `async: true` — Verify: `jq '.hooks.PostToolUse[] | select(.matcher=="Write|Edit") | .hooks[].command' hooks/hooks.json | grep -c plan-mirror` >=1; `jq '.hooks.PostToolUse[] | select(.hooks[].command | test("plan-mirror")) | has("if")' hooks/hooks.json` == `false`
- [ ] 5.4 Rewrite `OMCA.md:27` and `:484-485` — native plans first with "authoritative" label; `.omca/plans/` described as backup; call out `boulderBackupEnabled` default — Verify: `grep -nE '\.claude/plans/.*authoritative|native.*authoritative' OMCA.md` matches at lines near 27 and 484; `grep -nE '\.omca/plans/.*backup|backup.*\.omca/plans/' OMCA.md` matches
- [ ] 5.5 Rewrite `skills/prometheus-plan/SKILL.md:18-30` — drop "Copy to `.omca/plans/`" instruction (hook handles) — Verify: `grep -cE 'Copy to.*\.omca|Write to.*\.omca/plans' skills/prometheus-plan/SKILL.md` == 0; `grep -cE 'plan-mirror|automatic.*backup' skills/prometheus-plan/SKILL.md` >=1
- [ ] 5.6 Update `skills/start-work/SKILL.md` step 1 — new sub-step: if boulder `active_plan` missing, check `.omca/plans/<name>.md`, restore via `cp`, boulder pointer unchanged — Verify: `grep -nE 'backup.*\.omca/plans|recover.*from.*backup' skills/start-work/SKILL.md` matches; `grep -cE 'cp.*\.omca/plans.*\.claude/plans' skills/start-work/SKILL.md` >=1
- [ ] 5.7 Update `scripts/subagent-start.sh` — before error-log on missing plan, attempt backup fallback at `${PROJECT_ROOT}/.omca/plans/$(basename)` — Verify: `grep -nE '\.omca/plans.*fallback|backup.*fallback' scripts/subagent-start.sh` matches; bats fixture with missing native + present backup confirms context injection uses backup
- [ ] 5.8 Add `tests/bats/plans/mirror_and_recovery.bats` — (a) mirror on Write, (b) recovery on missing native, (c) `BOULDERBACKUPENABLED=false` disables mirror — Verify: `just test-bats -- tests/bats/plans/`
- [ ] 5.9 Update `CHANGELOG.md` with dual-write model + ownership reconciliation note — Verify: `grep -c 'plan backup\|hybrid plan' CHANGELOG.md` >=1

**Risks**: Prometheus incremental writes fire multiple Write events (mitigated by async); cross-filesystem `mv` fails (cp fallback); Edit tool on existing plans needs matcher `Write|Edit`; disabling backup post-mirror doesn't delete existing mirrors (document).

---

### Group 2: `channels` — notification routing (OPT-IN + VERIFIED, research preview)

**User directive (post-approval correction)**: Channels are **off by default** and **never activate without (a) user opt-in during `omca-setup` AND (b) a verification ping confirming delivery works**. If verification fails, `notifyChannel` stays `off` and no credentials persist. This is stricter than "userConfig default off" — the bridge itself must be inert until these gates pass.

**Three gates before any channel delivery**:
1. `notifyChannel` userConfig is NOT `off` (user chose a backend)
2. `omca-setup` Channels phase (task 2.10) completed with credentials
3. Verification ping (task 2.11) returned success

If ANY gate is open, bridge is inert, no credentials persist, no outbound network traffic.

**Goal**: Bridge `scripts/notify.sh` to Telegram/Slack via platform channels, gated by the three conditions above. Reverses `OMCA.md:29` "Channels: Not used" but with explicit opt-in + verification machinery.

**New files**:
- `scripts/channel-forward.sh` — Bash gate; POSTs title+message to `127.0.0.1:8789` when `NOTIFYCHANNEL != off`
- `servers/channel-bridge/bridge.py` — FastMCP server declaring `capabilities.experimental['claude/channel'] = {}`. Local HTTP listener forwards POSTs as `notifications/claude/channel`. Outbound Telegram via keychain token.
- `servers/channel-bridge/pyproject.toml` — matches OMCA `servers/` conventions

**Tasks**:
- [ ] 2.1 Scaffold `servers/channel-bridge/` with `pyproject.toml` (ruff, uv) — Verify: `uv run --project servers/channel-bridge ruff check` exit 0
- [ ] 2.2 Implement `bridge.py` — FastMCP, capability declaration.

  **Conditional startup (user directive)**: The bridge's HTTP listener only opens when **all three gates** pass:
  1. `CLAUDE_PLUGIN_OPTION_NOTIFYCHANNEL != "off"`
  2. Required credentials present in keychain/userConfig (Telegram: token + chat ID; Slack: webhook URL)
  3. `.omca/state/channels-verified.json` exists with `ok: true` (written by task 2.11 verification)

  When ANY gate fails, the FastMCP server may start (if Claude Code invokes it) but **MUST NOT** bind any TCP port, MUST NOT attempt Telegram/Slack authentication, MUST NOT write `channel-bridge.json`. In this inert mode, the server exits cleanly on any MCP message with `{"error": "channels not enabled — run /oh-my-claudeagent:omca-setup and choose Channels phase to configure"}` and closes.

  When all gates pass: HTTP listener **bound to `127.0.0.1` only (never `0.0.0.0`)**, port discovery loop (try 8789 → 8790 → 8791; FAIL with clear error if all three busy — do NOT fall back to ephemeral since `channel-forward.sh` cannot reliably discover ephemeral ports without the state file being current).

  **Stale state-file startup policy** (only applies in active mode): on startup, if `.omca/state/channel-bridge.json` already exists: (a) read `pid` field; (b) `kill -0 $pid` to check process liveness; (c) if alive → exit 1 with error `"channel-bridge already running on PID $pid"`; (d) if dead → log recovery, overwrite state file. State file shape: `{"port": <int>, "pid": <int>, "session_id": "<id>", "started_at": "<iso8601>"}`. **Concurrent-startup race mitigation**: write state file with `O_EXCL | O_CREAT` (atomic create-or-fail); if create fails, fall through to the stale-PID branch (b–d). POST body → `notifications/claude/channel`. On SIGTERM, remove state file. SIGKILL leaks state file (documented in Risks; `omca-clear` recovers).

  — Verify: `uv run --project servers/channel-bridge python -c "import bridge"` exit 0; inert-mode unit test asserts NO port bound when `NOTIFYCHANNEL=off`; inert-mode unit test asserts NO port bound when credentials missing; inert-mode unit test asserts NO port bound when `channels-verified.json` absent; active-mode unit tests assert `bind_address == "127.0.0.1"`, port-discovery, state-file writes; multi-instance test (second bridge EXITS non-zero when first alive); crash-recovery test (overwrite cleanly); port-exhaustion test (exit 1 clear message); SIGTERM test (state file removed)
- [ ] 2.3 Create `scripts/channel-forward.sh` — no-op when `NOTIFYCHANNEL=off`; else **require** `.omca/state/channel-bridge.json` (no hardcoded port default); if file missing → log to stderr `"channel-bridge not running; skipping"` and exit 0 (non-fatal since bridge is opt-in); else read port via `jq -r '.port'`; `curl -s -m 2 -X POST -d "$1: $2" http://127.0.0.1:${PORT}` — Verify: `shellcheck scripts/channel-forward.sh`; fixture test with synthetic state file asserts correct port used; fixture test WITHOUT state file asserts silent exit 0 and stderr log message; fixture test with malformed JSON in state file asserts silent exit 0 (no curl to undefined port)
- [ ] 2.4 Edit `scripts/notify.sh` — after `send_notification`, guarded call to `channel-forward.sh` — Verify: `bash -n && shellcheck scripts/notify.sh`
- [ ] 2.5 Add `channels` array + `mcpServers.omca-channel-bridge` to `.claude-plugin/plugin.json` — **note**: static manifest registration is required (plugin.json is a static artifact, cannot conditionally register), but the bridge runs in INERT MODE by default (see 2.2 gates). Mere registration does NOT activate channel delivery — user must complete 2.10 setup and 2.11 verification — Verify: `jq '.channels[0].server' .claude-plugin/plugin.json` == `"omca-channel-bridge"`; after install but before omca-setup, `ps aux | grep channel-bridge` shows no listening process (inert mode)
- [ ] 2.6 Rewrite `OMCA.md:29` — opt-in bridge description emphasizing the **three gates** (notifyChannel != off + setup phase + verification success). Describe inert-mode default; explain that registration in plugin.json alone does nothing; point users at `/oh-my-claudeagent:omca-setup` Channels phase. Also: `channelsEnabled` managed-setting interaction, claude.ai login requirement — Verify: `grep -c 'Channels: Not used' OMCA.md` == 0; `grep -cE 'three gates|inert mode|setup.*phase.*verif|verification.*ping' OMCA.md` >=1
- [ ] 2.7 Add `tests/bats/channels/notify_channel_gate.bats` — `NOTIFYCHANNEL=off` (no-op); `=telegram` attempts curl — Verify: `just test-bats -- tests/bats/channels/`
- [ ] 2.8 Update `omca-setup --doctor` to detect managed `channelsEnabled=false` blocking channel delivery — Verify: new doctor check appears in output
- [ ] 2.9 Add example `.mcp.json` snippet to `OMCA.md` channels subsection — shows how users consume the bridge standalone (outside Claude Code plugin invocation) — Verify: `grep -cE '"omca-channel-bridge".*:.*command' OMCA.md` >=1
- [ ] 2.10 Add **Phase 6: Channels (optional)** to `skills/omca-setup/SKILL.md`. Flow:
  1. Prompt: "Enable Telegram/Slack channel notifications? [y/N]" (default N)
  2. If N or empty response: set `notifyChannel=off` in userConfig, log "Channels disabled (default)"; delete `.omca/state/channels-verified.json` if present; exit phase
  3. If Y: prompt backend choice — `telegram|slack`
  4. Collect credentials (hold in memory only — do NOT persist yet):
     - Telegram: bot token + chat ID
     - Slack: webhook URL
  5. Invoke `scripts/channel-verify.sh` (task 2.11) with the in-memory credentials
  6. On verification **SUCCESS**:
     - Persist credentials to keychain (via sensitive userConfig) + non-sensitive keys to userConfig
     - Set `notifyChannel=<backend>`
     - Write `.omca/state/channels-verified.json` with `{"ok": true, "backend": "...", "verified_at": "<iso8601>"}`
     - Log "Channels enabled (verified)"
  7. On verification **FAILURE**:
     - **Discard credentials** (do NOT persist even partially)
     - Set `notifyChannel=off`
     - Delete any stale `channels-verified.json`
     - Display error message with backend-specific troubleshooting (wrong token, blocked chat ID, network issue)
     - Suggest re-running `/oh-my-claudeagent:omca-setup` after user fixes the issue
  — File: `skills/omca-setup/SKILL.md` — Verify: `grep -c '^## Phase 6' skills/omca-setup/SKILL.md` >=1; `grep -cE 'verification.*SUCCESS|verification.*FAIL' skills/omca-setup/SKILL.md` >=2; synthetic failure-path test confirms no credentials in userConfig after failed verify; synthetic success-path test confirms `channels-verified.json` written only on success
- [ ] 2.11 Create `scripts/channel-verify.sh` — verification helper invoked by 2.10. Contract:
  - Reads backend + credentials from stdin JSON: `{"backend": "telegram", "token": "...", "chat_id": "..."}` or `{"backend": "slack", "webhook": "..."}`
  - For Telegram: `curl -s -m 10 "https://api.telegram.org/bot${TOKEN}/sendMessage" -d "chat_id=${CHAT_ID}&text=OMCA channel verification ping ($(date -u +%FT%TZ))"` → assert HTTP 200 AND response JSON has `ok: true`
  - For Slack: `curl -s -m 10 -X POST "${WEBHOOK_URL}" -H 'Content-Type: application/json' -d '{"text":"OMCA channel verification ping"}'` → assert HTTP 200
  - On success: stdout `{"ok": true, "backend": "...", "verified_at": "<iso8601>"}`, exit 0
  - On failure: stderr clear error; stdout `{"ok": false, "error": "..."}`, exit 1
  - NO persistence of any kind (pure verification helper)
  — File: `scripts/channel-verify.sh` — Verify: `shellcheck scripts/channel-verify.sh`; mocked-HTTP success test asserts exit 0 + valid JSON; mocked-HTTP 401 test asserts exit 1 + clear error; timeout test (server doesn't respond in 10s) asserts exit 1 + timeout message
- [ ] 2.12 Update `omca-setup --doctor` (extends 3.5 + 2.8): channel status check
  - If `notifyChannel == off`: print "Channels: disabled (default)" — exit 0 for this check
  - If `notifyChannel != off`: re-invoke `channel-verify.sh` with stored credentials; on success print "Channels: enabled and verified (<backend>)"; on failure print "Channels: enabled but DELIVERY FAILING — re-run `/oh-my-claudeagent:omca-setup` Phase 6 to re-verify" and mark doctor exit code 1
  — File: `skills/omca-setup/SKILL.md` (DOCTOR MODE section) — Verify: doctor output contains a `Channels:` status line; failing-bridge mock produces exit 1 + re-setup guidance text

**Risks**:
- **Default-inert posture**: after install, bridge does not bind any port, does not request credentials, does not deliver messages. Only user action (omca-setup Phase 6 + successful verification) activates delivery. This is the user directive, not a soft default.
- **Credential-before-verification leak prevention**: credentials held in-memory only during Phase 6 verification. Persisted to userConfig + keychain ONLY after 2.11 verification returns `ok: true`. Failed verification discards credentials — user must re-enter on retry. Prevents silent half-enablement where the token is stored but delivery was never proven.
- Channels are research preview (pin min v2.1.92 in docs); require claude.ai login (console/API-key users excluded — document)
- Managed `channelsEnabled=false` silently blocks (doctor catches); must be distinguished from user-opt-out in doctor output
- NOT opting into permission-relay capability (one-way only, no remote-approval risk)
- **Localhost-only binding** is non-negotiable: binding to `0.0.0.0` would expose the bridge to LAN, which violates the one-way local-bridge model
- **Port conflict in concurrent sessions**: two Claude Code sessions on same machine each try to spawn a bridge. Resolution: first bridge binds 8789, writes state file with PID; second bridge detects live PID via `kill -0`, exits with clear error. User must run only one bridge per machine (documented limitation)
- **Port exhaustion** (8789/90/91 all externally busy): bridge exits with error rather than falling back to ephemeral. Rationale: `channel-forward.sh` would otherwise have no reliable way to find the port if state file is missing/stale, and ephemeral-fallback hides port-squatting bugs
- **SIGKILL leaks state file**: on SIGKILL (not SIGTERM), bridge cannot clean `.omca/state/channel-bridge.json`. Next startup checks `kill -0` on the recorded PID; dead PID → recovery (overwrite). Live PID (unrelated process reused the number) → false-positive block. Extremely rare; `omca-clear` removes the stale state
- **`channel-forward.sh` absent-state behavior**: when state file missing, script logs to stderr and exits 0 (non-fatal). This means notifications silently drop if the bridge never started. Trade-off: `channel-forward.sh` is called from the `notify.sh` hook, and a failed curl must not block the hook chain
- **Verification staleness**: `channels-verified.json` is written once per setup; if the Telegram bot token is revoked later or the Slack webhook expires, the bridge remains "enabled" in userConfig but delivery silently fails. Mitigation: `omca-setup --doctor` re-runs verification (task 2.12); users should periodically run doctor

---

### Group 4: `bin/` — `omca` CLI (Bash, not Python)

**Goal**: Ship `omca-status`, `omca-doctor`, `omca-clear` as plugin-provided executables on PATH when plugin is enabled.

**Decision**: Bash matches existing `scripts/*.sh` convention; no new runtime dep. All three derive state dir from `$(git rev-parse --show-toplevel)/.omca/state`. All prefixed `omca-` to avoid PATH collisions.

**New files**:
- `bin/omca-status` — reads state JSONs, prints summary, read-only
- `bin/omca-doctor` — wraps key checks from omca-setup DOCTOR MODE (jq, uv, ast-grep, layout, MCP smoke)
- `bin/omca-clear` — invokes `mode_clear` via omca MCP if reachable, else deletes state JSONs after `[y/N]` confirm (`-y` skip). NEVER touches `.omca/plans/` or `.omca/logs/`.

**Tasks**:
- [ ] 4.1 Create `bin/omca-status` — state summary via jq — Verify: `shellcheck bin/omca-status && bin/omca-status` exits clean
- [ ] 4.2 Create `bin/omca-doctor` — dep + state + MCP smoke checks — Verify: `shellcheck bin/omca-doctor`
- [ ] 4.3 Create `bin/omca-clear` — interactive confirm, `-y` skip, `-n` dry-run; never touches plans/logs — Verify: `shellcheck bin/omca-clear && echo n | bin/omca-clear` exits with "aborted"
- [ ] 4.4 `chmod +x bin/omca-*` — Verify: `ls -l bin/` shows 3 executables
- [ ] 4.5 Add "CLI tools" section to `OMCA.md` after Troubleshooting — bin/ only on PATH when plugin enabled — Verify: `grep -c '^## CLI tools' OMCA.md` >=1
- [ ] 4.6 Add `tests/bats/bin/omca_cli.bats` — status on empty state, doctor on missing jq (simulated), clear `-n` dry-run — Verify: `just test-bats -- tests/bats/bin/`
- [ ] 4.7 (optional, post-Group 5) Enhance `bin/omca-status` to display `.omca/plans/` mirror freshness — Verify: output line includes "Plan backup: <n> mirrored"
- [ ] 4.8 Add `bin/omca-version` — prints version from `.claude-plugin/plugin.json`, exit 0. Symmetric with omca-status/doctor/clear — Verify: `shellcheck bin/omca-version && bin/omca-version` prints `1.6.0`

**Risks**: PATH only active while plugin enabled (document); `omca-` prefix avoids shadowing system tools; `omca-clear` destructive — always confirm unless `-y`.

---

### Group A: Per-skill description tuning (NO BLANKET CAP)

**User directive (post-approval correction)**: Each skill's description must be tuned individually. No blanket OMCA-stylistic cap (not 250, not 500, not any fixed number). The only hard cap enforced is the platform's own 1,536-char combined limit.

**Goal**: Audit each skill individually and tune every description to the minimum-effective length for ITS OWN trigger accuracy. Different skills have different triggering needs — a rarely-fired skill may need a descriptive trigger block; a skill with obvious trigger words needs only a few words. Imposing a blanket cap is either too tight for some or too generous for others.

**Tasks**:

- [ ] A.1 Enumerate all skills — build per-skill audit table in notepad `decisions`: name, current `description` length, current `when_to_use` length (or 0 if absent), combined length, trigger-frequency (rare / moderate / frequent), evaluator notes — Verify: table has one row per skill under `skills/*/SKILL.md`; all rows have non-null combined length; every row is under platform cap 1,536
- [ ] A.2 Per-skill tuning — **one sub-task per skill**. Atlas decomposes A.2 into N sub-tasks (one per skill discovered in A.1) and delegates to `sisyphus-junior` agents (parallel where no shared-file conflict exists). For EACH skill:
  - (a) Read current `description` + `when_to_use`
  - (b) Assess trigger accuracy: does the text clearly signal WHEN this skill should fire? Is every word load-bearing? Would removing a word change routing accuracy?
  - (c) Tighten: drop buzzwords, remove redundant phrasing, keep only what distinguishes this skill from siblings
  - (d) Test (mental simulation): given the new description, would Claude route correctly on 5 representative prompts? If tightening hurts accuracy, revert.
  - (e) Record before/after lengths + rationale + the 5 test prompts in notepad `decisions`

  **Hard constraint**: combined length must never exceed platform cap 1,536 chars.
  **Soft constraint**: shorter is preferred ONLY IF trigger accuracy is preserved — never sacrifice accuracy for brevity.

  — Verify per skill: description still captures trigger conditions (via step d simulation); diff shows only description/when_to_use prose changes (no frontmatter key removal, no skill-name change)
  — Aggregate verify: `bash scripts/validate-plugin.sh --check claims` shows no WARN/ERROR for any skill
- [ ] A.3 Update `scripts/validate-plugin.sh:521-522` — **remove OMCA-stylistic cap entirely**. Warn only when combined length exceeds platform cap 1,536. Replace the "Claude Code v2.1.84+ may truncate" comment (false premise) with: `# Skill description cap is platform-imposed (1,536 combined) per skills.md:192-193. OMCA does NOT impose a stylistic sub-cap — each skill is tuned individually per A.2.` — Verify: `grep -cE "max_len=(250|500)\b" scripts/validate-plugin.sh` == 0; `grep -cE "max_len=1536|1,?536" scripts/validate-plugin.sh` >=1; `grep -c "v2.1.84+ may truncate" scripts/validate-plugin.sh` == 0; `bash scripts/validate-plugin.sh --check claims` PASSes for all skills after A.2
- [ ] A.4 Update `CLAUDE.md:38` — replace "Skill descriptions must be ≤250 characters (Claude Code truncates)" with "Skill descriptions are tuned individually per skill — no blanket OMCA cap. Validator enforces only the platform cap (1,536 chars combined) per `skills.md:192-193`. Run `validate-plugin.sh` to check." — Verify: `grep -cE "tuned individually|no blanket" CLAUDE.md` >=1; `grep -c "Claude Code truncates" CLAUDE.md` == 0; `grep -c "≤250 characters" CLAUDE.md` == 0
- [ ] A.5 Teach validator to sum `description + when_to_use` (original Group A risk note) — when frontmatter has `when_to_use`, combined length = description + when_to_use; otherwise description only — Verify: synthetic test skill with description=1000 + when_to_use=600 (combined 1600) WARNs; same skill with description=1000 only PASSes; `tests/bats/validate-plugin/skill_description_combined.bats` added with both scenarios

**Execution note**: A.2 is THE bulk of Group A work (N sub-tasks for N skills). Atlas should run A.1 first, then fan A.2 out across parallel sisyphus-junior agents keyed by skill path (non-overlapping file writes → safely parallel). A.3/A.4 run AFTER all A.2 sub-tasks complete (they depend on every skill being under the platform cap). A.5 parallel with A.2.

**Risks**:
- Per-skill prose changes introduce inconsistent voice across skills. Mitigation: record voice/style rules in notepad during A.1 audit ("imperative mood", "trigger-first phrasing", "no adjectives that don't change routing"), apply consistently in A.2.
- Some skills may already be optimal — tightening could harm trigger accuracy. A.2 step (d) mental simulation is the guardrail; if the 5-prompt test degrades, revert.
- Ambiguous tuning cases (skills with unclear trigger direction): atlas should batch these as AskUserQuestion items rather than guessing. Pattern: record in notepad `questions` section, raise to user after obvious wins are in.

---

### Group B: Stale-reference scrub (VERIFICATION-ONLY NO-OPS)

**Goal**: Confirm zero unwanted references; document result in notepad.

**Tasks**:
- [ ] B.1 `grep -rn "enable-auto-mode" /home/utsav/dev/softs/oh-my-claudeagent` — Expected: exit 1 (no matches)
- [ ] B.2 `grep -rn "web-scheduled-tasks" /home/utsav/dev/softs/oh-my-claudeagent` — Expected: exit 1
- [ ] B.3 `grep -rn "Task(" /home/utsav/dev/softs/oh-my-claudeagent/agents /home/utsav/dev/softs/oh-my-claudeagent/skills /home/utsav/dev/softs/oh-my-claudeagent/OMCA.md` — Expected: exit 1 (two historical references in CHANGELOG and validate-plugin.sh test matcher label are intentional, outside these paths)
- [ ] B.4 Record B.1–B.3 outputs in notepad `decisions` section so Oracle's scrub concern is closed — File: notepad only

---

### Group C: Doc-drift repairs (Oracle's 4 gaps)

**Goal**: Reconcile four internal contradictions between OMCA.md, CLAUDE.md, and agent definitions.

**Tasks**:
- [ ] C.1 Fix plan-path contradiction — edit `OMCA.md:27` per user's "native authoritative, `.omca/plans/` backup" ruling; verify `OMCA.md:484` alignment — Verify: `grep -n "\.omca/plans\|\.claude/plans" OMCA.md` shows native first with authoritative label
- [ ] C.2 Apply Group A.2 decision to `CLAUDE.md:38` — remove false "Claude Code truncates" unless truly at 1,536 — Verify: line 38 wording corrected
- [ ] C.3 Verify `CLAUDE.md:11` hook count — Expected no-op since count confirmed 23 — Verify: `jq '.hooks | keys | length' hooks/hooks.json` == 23
- [ ] C.4 Reconcile managed-settings lists — make `OMCA.md:586-601` the authoritative table (user-facing); replace `CLAUDE.md:59` inline list with cross-reference; append the 6 "additional keys" CLAUDE.md had to the OMCA.md table — Verify: `grep -c "OMCA.md" CLAUDE.md` >=1 (new cross-reference); managed-keys intersection complete

**Risks**: C.4 loses copy-isolation; if CLAUDE.md must stand alone offline, keep two synced copies with `# SYNC: mirrors OMCA.md § Managed Settings` headers.

---

### Group D: Low-risk hook improvements

**Goal**: Silence noisy async observability hooks; emit `sessionTitle` on ralph/ultrawork activation; document `json-error-recovery.sh` intent.

**Tasks**:
- [ ] D.1 Add `"suppressOutput": true` to `instructions-loaded-audit.sh` (InstructionsLoaded), `post-edit.sh` (PostToolUse Write|Edit), `config-change-audit.sh` (ConfigChange), `notify.sh` (Notification) entries in `hooks/hooks.json`. All four confirmed async + silent — Verify: `jq '[.hooks[][].hooks[] | select(.suppressOutput == true)] | length' hooks/hooks.json` == 4 (or more if existing); `just test-hooks` passes
- [ ] D.2 Extend `scripts/keyword-detector.sh` — emit `hookSpecificOutput.sessionTitle` when ralph/ultrawork detected. **Format locked**: ralph → `[RALPH] <first 40 chars of prompt>`, ultrawork → `[ULW] <first 40 chars of prompt>`. Escape via `jq -Rs`. JSON shape per `hooks.md:847,856` — Verify: feed `{"prompt":"ralph don't stop","hook_event_name":"UserPromptSubmit"}` fixture in; `jq -r '.hookSpecificOutput.sessionTitle'` returns `[RALPH] ralph don't stop`; feed ultrawork fixture; returns `[ULW] <...>`; non-ralph/non-ulw prompt returns no `sessionTitle` field
- [ ] D.3 `json-error-recovery.sh` — **leave unfiltered**; add 5-line comment header documenting why (permission-rule `if:` syntax is Bash-matcher only; no "not these tools" negation possible). Cite `.claude/rules/hook-scripts.md` — Verify: `head -5 scripts/json-error-recovery.sh` shows rationale; `just test-hooks` PASS

**Risks**: D.2 — `sessionTitle` introduced at specific platform version; plan.json min version must support it; platform ignores unknown fields (acceptable).

---

### Group E: `effort: xhigh` semantics (VERIFICATION DONE)

**Goal**: Record the verification finding + keep `effort: max` on oracle.md with rationale.

**Tasks**:
- [ ] E.1 Record verification finding in notepad — `xhigh` sits BETWEEN `high` and `max` per changelog.md:18,20; not a rename; `max` still correct for oracle
- [ ] E.2 Add rationale comment to `agents/oracle.md` above frontmatter: `<!-- effort: max kept intentionally (v1.6.0). xhigh is Opus-4.7-only and sits BELOW max; oracle must retain absolute ceiling. -->` — Verify: `grep -n "effort: max" agents/oracle.md` shows line 5; comment present
- [ ] E.3 Document rejected alternatives (switch to xhigh; userConfig-gated) in notepad `decisions` for future reference

**Risks**: If future platform deprecates `max` in favor of `xhigh`, revisit — add watch note to notepad `issues` section.

---

### Group F: Stale-state hook firing (diagnose-first, then fix)

**Goal**: Eliminate spurious `final-verification-evidence.sh` and `ralph-persistence.sh` Stop feedback during plan-mode drafting. **Momus correction**: the original F.1 proposed a phantom `CLAUDE_PLAN_MODE` env var that does not exist in the platform. Reframed to diagnose the actual trigger first, then fix from evidence.

**Observed symptom**: During this plan-drafting session (no atlas execution, no ralph loop started), `final-verification-evidence.sh` demanded F1–F4 evidence, and `ralph-persistence.sh` emitted `[PERSISTENCE] Active work plan detected via boulder. Continue working on tasks.` The trigger is likely (a) boulder.json carries `active_plan` from a prior session that never cleared, and/or (b) `ralph-state.json` has `status: active` from a prior session.

Platform inputs available to hooks (per `hooks.md`): `session_id`, `transcript_path`, `stop_hook_active`. There is NO `plan_mode` flag. Gating must use `session_id` comparison with recorded state, NOT a hypothetical env var.

**Tasks** (MUST execute in declared order — F.1 gates F.2/F.3):

- [ ] F.1 **Diagnose (BLOCKS F.2/F.3)** — reproduce the symptom in a controlled test: start a fresh Claude Code session with a boulder.json carrying an `active_plan` from a prior session, enter plan mode, observe hook firings. Capture `HOOK_INPUT` JSON from both `final-verification-evidence.sh` and `ralph-persistence.sh` (tee stdin to a temp file at script entry). Record exact input fields + state-file contents that triggered the fire — File: `.omca/notes/group-f-diagnosis.md` + notepad `problems` section (the plan file itself is READ-ONLY during execution; diagnosis findings do NOT edit this plan) — Verify: `.omca/notes/group-f-diagnosis.md` exists and identifies (a) which state file contains the stale marker, (b) which condition branch in each script matches, (c) whether `HOOK_INPUT.session_id` is present and stable, (d) whether SessionEnd hook fires on normal exit. If F.1 reveals `session_id` is NOT available or NOT stable, STOP and consult Oracle before F.2.

- [ ] F.2 **Fix stale-state clearance (primary fix)** — Add `session_id` tracking to state-file writers. Concrete writers identified by grep:
  - `scripts/ralph-persistence.sh` (writes `.omca/state/ralph-state.json`)
  - `servers/*/` MCP tools `boulder_write` / `boulder_progress` (writes `.omca/state/boulder.json`)
  - `scripts/ultrawork-*.sh` if present (writes `.omca/state/ultrawork-state.json`)

  On SessionEnd hook (already registered per `hooks.json` — use the existing handler path, do NOT register a new one), clear `.omca/state/*.json` files whose recorded `session_id` doesn't match the ending session. If a writer predates this change and lacks `session_id`, treat as stale.

  — Files: `scripts/ralph-persistence.sh`, `servers/omca/` boulder writer (Python/FastMCP), plus the existing SessionEnd hook script (find via `jq '.hooks.SessionEnd[].hooks[].command' hooks/hooks.json`) — Verify: bats fixture seeds ralph-state.json with `session_id: "stale-123"`, triggers SessionEnd with `HOOK_INPUT.session_id: "current-456"`, asserts state cleared; same fixture for boulder.json; writer-predates test: state file without `session_id` field → treated as stale, cleared

- [ ] F.3 **Fix hook gating (defensive backstop)** — In `scripts/final-verification-evidence.sh` (currently gates on `ACTIVE_PLAN!=""` + `MARKER_PLAN!=""` + `INCOMPLETE>0` per lines 49–72), add: compare boulder's recorded `session_id` to `HOOK_INPUT.session_id`; if mismatch or missing in boulder, exit 0 silently (stale state, not current-session work). Same pattern for `ralph-persistence.sh`'s `RALPH_ACTIVE==true` check — Files: `scripts/final-verification-evidence.sh`, `scripts/ralph-persistence.sh` — Verify: bats fixture seeds boulder with `session_id: "prior-session"`, submits hook with `HOOK_INPUT.session_id: "current-session"`, asserts exit 0 silent

- [ ] F.4 Add `tests/bats/hooks/stale_state_gating.bats` — scenarios: (a) matching session_id → fires normally, (b) mismatching session_id → silent, (c) missing session_id in state → treat as stale → silent, (d) clean slate → silent — Verify: `just test-bats -- tests/bats/hooks/stale_state_gating.bats` passes all 4

- [ ] F.5 Document stale-state pattern in `.claude/rules/hook-scripts.md` under new "Session-scoped state" subsection — include guidance that any state writer must record `session_id`; explicitly list the 3 affected state files — Verify: `grep -cE 'Session-scoped state' .claude/rules/hook-scripts.md` >=1

**Risks**:
- If Claude Code's `session_id` is not stable within a single session (e.g., regenerated on compaction), state writers may over-clear. Verify stability in F.1 diagnosis.
- State writers that predate this change won't have `session_id` — treat missing field as "unknown = stale" (safer default).
- `SessionEnd` hook may not fire on abnormal exit (crash, kill) — orphaned state can still accumulate; document this as known limitation.

---

## Cross-group dependencies

1. **Group 3 is foundational** — Groups 2 (`NOTIFYCHANNEL`, `TELEGRAMBOTTOKEN`, `TELEGRAMCHATID`), 5 (`BOULDERBACKUPENABLED`), and A/C coordination consume its keys.
2. **Group 5 depends on Group 3** — `plan-mirror.sh` gates on `BOULDERBACKUPENABLED`.
3. **Group 2 depends on Group 3** — channel bridge reads 3 userConfig keys.
4. **Group 4 optionally extends after Group 5** — `omca-status` mirror-freshness line (task 4.7).
5. **Group A.2 decision gates C.2 and A.3/A.4** — cap number must be chosen before doc edits.
6. **Group F is independent** — plan-mode gating touches 2 scripts + new bats; parallel-safe.
7. **Groups B, C.3, E are verification-only no-ops** — run first to clear gates cheaply.
8. **All groups write to `CHANGELOG.md`** — consolidate under single `## v1.6.0` heading with subsections to avoid merge conflicts.

## Execution Order (atlas executes in this order)

**Wave 1 — verification no-ops (closes gates cheaply)**:
- B.1, B.2, B.3, B.4
- C.3
- E.1, E.2, E.3

**Wave 2 — foundational**:
- Group 3 in sequence (3.1 → 3.2 → 3.3–3.7 parallel)

**Wave 3 — parallel adopters** (groups parallel; some tasks sequential within a group):
- Group 1 (monitors) — tasks parallel
- Group 5 (plan backup) — tasks parallel
- Group A (skill audit — A.1 → A.2 decision → A.3–A.5 parallel)
- Group D (hook tweaks) — tasks parallel
- Group F (stale-state hook firing) — **F.1 MUST complete before F.2/F.3**; F.4/F.5 parallel after F.3 lands

**Wave 4 — depends on Group 3 + A decision**:
- Group C — C.1 parallel with others; C.2 after A.2; C.4 last doc edit (largest blast radius)
- Group 2 (channels) — depends on Group 3; scaffold parallel with Wave 3

**Wave 5 — final polish**:
- Group 4 (bin/ CLI) — 4.1–4.6 standalone; 4.7 enhancement after Group 5 lands

**Wave 6 — final verification + release** (execute in this explicit order):
1. `just ci` (lint + fmt + test + hooks + bats + mcp) — must exit 0 before any release step
2. Version bump `.claude-plugin/plugin.json` → v1.6.0
3. `CHANGELOG.md` v1.6.0 consolidation (AFTER version bump so the version matches) — merge all per-group CHANGELOG additions under a single `## [1.6.0]` heading, subsections by category (Capabilities / Fixes / Hook Gating / Drift Repair)
4. MEMORY.md update — record: (a) plan-mode hook false-positive pattern + diagnosis-first fix approach, (b) userConfig as foundational ordering constraint, (c) channel research-preview caveats, (d) **validated judgment call**: user overrode Oracle's minimal recommendation in favor of Large scope; future scope questions should present Oracle's view AND ask rather than auto-defer
5. Final `just ci` re-run to confirm MEMORY.md/CHANGELOG edits didn't break anything

## Critical Files to Modify

- `/home/utsav/dev/softs/oh-my-claudeagent/.claude-plugin/plugin.json`
- `/home/utsav/dev/softs/oh-my-claudeagent/hooks/hooks.json`
- `/home/utsav/dev/softs/oh-my-claudeagent/CLAUDE.md`
- `/home/utsav/dev/softs/oh-my-claudeagent/OMCA.md`
- `/home/utsav/dev/softs/oh-my-claudeagent/CHANGELOG.md`
- `/home/utsav/dev/softs/oh-my-claudeagent/settings.json`
- `/home/utsav/dev/softs/oh-my-claudeagent/templates/claudemd.md`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/validate-plugin.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/notify.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/keyword-detector.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/ralph-persistence.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/task-completed-verify.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/final-verification-evidence.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/subagent-start.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/json-error-recovery.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/instructions-loaded-audit.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/post-edit.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/config-change-audit.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/skills/omca-setup/SKILL.md`
- `/home/utsav/dev/softs/oh-my-claudeagent/skills/prometheus-plan/SKILL.md`
- `/home/utsav/dev/softs/oh-my-claudeagent/skills/start-work/SKILL.md`
- `/home/utsav/dev/softs/oh-my-claudeagent/agents/oracle.md`
- `/home/utsav/dev/softs/oh-my-claudeagent/.claude/rules/hook-scripts.md`

## Critical Files to Create

**Group 1**:
- `/home/utsav/dev/softs/oh-my-claudeagent/monitors/monitors.json`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/monitor-ralph-stall.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/monitor-ultrawork-idle.sh`

**Group 2**:
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/channel-forward.sh`
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/channel-verify.sh` (new; task 2.11 verification helper)
- `/home/utsav/dev/softs/oh-my-claudeagent/servers/channel-bridge/bridge.py`
- `/home/utsav/dev/softs/oh-my-claudeagent/servers/channel-bridge/pyproject.toml`

**Group 4**:
- `/home/utsav/dev/softs/oh-my-claudeagent/bin/omca-status`
- `/home/utsav/dev/softs/oh-my-claudeagent/bin/omca-doctor`
- `/home/utsav/dev/softs/oh-my-claudeagent/bin/omca-clear`

**Group 5**:
- `/home/utsav/dev/softs/oh-my-claudeagent/scripts/plan-mirror.sh`

**Tests**:
- `/home/utsav/dev/softs/oh-my-claudeagent/tests/bats/monitors/monitor_scripts.bats`
- `/home/utsav/dev/softs/oh-my-claudeagent/tests/bats/channels/notify_channel_gate.bats`
- `/home/utsav/dev/softs/oh-my-claudeagent/tests/bats/channels/bridge_inert_mode.bats` (new; Group 2 inert-mode asserts: no bind when gates fail)
- `/home/utsav/dev/softs/oh-my-claudeagent/tests/bats/channels/channel_verify.bats` (new; Group 2 task 2.11)
- `/home/utsav/dev/softs/oh-my-claudeagent/tests/bats/channels/setup_phase6.bats` (new; Group 2 task 2.10 success/failure paths)
- `/home/utsav/dev/softs/oh-my-claudeagent/tests/bats/user_config/keys.bats`
- `/home/utsav/dev/softs/oh-my-claudeagent/tests/bats/bin/omca_cli.bats`
- `/home/utsav/dev/softs/oh-my-claudeagent/tests/bats/plans/mirror_and_recovery.bats`
- `/home/utsav/dev/softs/oh-my-claudeagent/tests/bats/hooks/stale_state_gating.bats` (Group F)
- `/home/utsav/dev/softs/oh-my-claudeagent/tests/bats/validate-plugin/skill_description_combined.bats` (new; Group A task A.5 combined-length validator test)

## Assumptions

| Decision | Default Applied | Impact Level | Alternative | Review Note |
|---|---|---|---|---|
| Skill-cap enforcement (Group A) | **Per-skill tuning; no blanket OMCA cap**. Validator enforces only platform cap 1,536. | High | Keep 250 blanket / raise to 500 / raise to 1,536 | User directive: each skill tuned individually. Voice/style rules recorded during A.1 audit to keep consistency. |
| Channels default state | **Inert** (bridge does not bind, no credentials requested) until omca-setup Phase 6 + verification success | High | Auto-enable on install / soft opt-in via userConfig only | User directive: opt-in AND verify before any credentials persist or delivery attempted. Failed verification discards credentials. |
| Channel backend order in Phase 6 | Telegram listed first, Slack second | Medium | Slack first | Arbitrary ordering; atlas can adjust based on user preference |
| bin/ runtime | Bash | Low | Python | Matches OMCA scripts/ convention; no new runtime dep |
| `xhighEnabled` userConfig | Declared but not wired in v1.6.0 | Low | Wire up immediately | Placeholder for future effort-routing design; prevents later schema migration |
| `sessionTitle` min version | Use current plan.json min; platform ignores unknown fields | Low | Bump min version | Safer to avoid bumping minimum unless hook logic truly requires it |
| Managed-settings reconciliation (C.4) | Cross-reference with single-source OMCA.md | Medium | Sync two copies with # SYNC headers | If CLAUDE.md must stand alone offline, switch to sync'd copies |
| `.omca/plans/` mirror on incremental writes | Re-mirror on every Write/Edit (async) | Low | Debounce | Async hides latency; last-write-wins is fine |
| Monitor sleep floor | 30s | Low | 60s | Matches existing poll intervals elsewhere in OMCA |

## Open Decisions for Atlas (during execution)

Per Momus review + post-approval user corrections, previously-open decisions are now locked in-plan to prevent mid-execution deadlock:
- ~~Skill-cap value~~ — **NO BLANKET CAP** (user directive). Per-skill tuning per A.2; validator enforces only platform cap 1,536.
- ~~`sessionTitle` format~~ — LOCKED to `[RALPH]` / `[ULW]` in D.2
- ~~Channel bridge HTTP port~~ — LOCKED to discovery loop 8789→8790→8791→fail (no ephemeral fallback) in 2.2
- ~~Channels default state~~ — **INERT BY DEFAULT** (user directive). Opt-in via omca-setup Phase 6 + verification required. Inert = no port bind, no credentials, no delivery.
- ~~F.1 plan-mode gating mechanism~~ — REFRAMED to diagnose-first + session-ID scoping in F.1–F.3

Remaining open for atlas:

1. **`omca-doctor` exit code semantics** (4.2) — exit 0 all PASS; 1 any FAIL; 2 reserved for "partial/degraded"; atlas documents in help output
2. **F.1 diagnosis outcome** — if the diagnosis reveals a different root cause than stale `session_id` (e.g., a different state field carries the marker, or `session_id` is not available to the hook), F.2/F.3 fix scope adjusts. **Atlas records findings in `.omca/notes/group-f-diagnosis.md` + notepad only — does NOT edit this plan file** (plan files are read-only during execution per OMCA workflow). If diagnosis invalidates the F.2 `session_id` approach, atlas STOPS Group F and consults Oracle for an alternative before proceeding.
3. **CHANGELOG.md v1.6.0 headline order** — Wave 6 consolidation. Atlas picks order (capabilities first vs. fixes first) for readability.

## Success Criteria

### Verification Commands
```bash
just lint                                     # Expected: exit 0
just fmt-check                                # Expected: exit 0
just test-hooks                               # Expected: all hook tests pass
just test-bats                                # Expected: all bats tests pass (including new: monitors, channels, user_config, bin, plans, hooks/plan_mode_gating)
just test-mcp                                 # Expected: MCP tests pass (including new channel-bridge)
bash scripts/validate-plugin.sh               # Expected: plugin validates; no new WARN/ERROR
just ci                                       # Expected: exit 0
```

### Manual Verification
```bash
# Group 1 — monitors
claude --debug 2>&1 | grep -i 'monitor'       # Expected: 2 monitor lines loaded

# Group 2 — channels (requires claude.ai session)
claude --channels plugin:oh-my-claudeagent@omca  # Expected: bridge starts, accepts POSTs

# Group 4 — bin/
omca-status                                   # Expected: state summary
omca-doctor                                   # Expected: all checks PASS
echo n | omca-clear                           # Expected: "aborted"

# Group 5 — plan backup + recovery
# Write .claude/plans/foo.md → verify .omca/plans/foo.md appears (diff identical)
# rm .claude/plans/foo.md → /oh-my-claudeagent:start-work → recovers from backup
```

### Final Checklist
- [ ] All "Must Have" items present and verified
- [ ] All "Must NOT Have" guardrails respected
- [ ] Groups 1–5 + A–F all have passing verification commands
- [ ] CHANGELOG.md v1.6.0 entry consolidates all group additions
- [ ] plugin.json version bumped to 1.6.0
- [ ] MEMORY.md updated with learnings (plan-mode hook gating pattern, userConfig foundational ordering, channel research-preview caveats)
- [ ] Momus reviewed this final plan and returned OKAY (per Q8=C)
- [ ] User approved via ExitPlanMode before atlas starts
