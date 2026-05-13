# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-05-13

v2.2.0 ships platform-sync improvements: a `PermissionDenied` retry-coach hook, statusline token-count fixes aligned to the v2.1.132 schema, new agent `color:` and `background:` frontmatter across all 10 agents, two new `bin/` utilities (`omca-status`, `omca-doctor`), and documentation catch-up for new platform settings keys and env vars.

### Added

- **`PermissionDenied` retry-coach hook handler** — coaches the model after auto-mode-classifier denials with `{retry: true}` and an `additionalContext` hint for known-recoverable Bash patterns.
- **`subagentStatusLine` plugin-level default** at `<plugin-root>/settings.json`, backed by `bin/omca-subagent-statusline`. Renders per-row token counts and task type in the subagent panel.
- **`bin/omca-status`** — print active boulder, evidence summary, F1-F4 status, and currently-running subagents from any Bash tool call.
- **`bin/omca-doctor`** — standalone read-only health check (dependencies, settings, state directories, CLAUDE.md migration state). Mirrors the `/oh-my-claudeagent:omca-setup --doctor` checks without invoking the slash command.
- **`color:` and `background:` on agent frontmatter** across all 10 agents (`background: true` only on `explore` + `librarian`). Color table recorded in `.claude/rules/agent-conventions.md`.
- **`when_to_use:` field** separated from `description:` on 5 user-facing skills (handoff, hephaestus, init-deep, omca-setup, github-triage).

### Changed

- **`explore` and `librarian` agents** now declare `background: true` in frontmatter (always run as background tasks). Callers no longer need to pass `run_in_background=true` explicitly for these two agents.

### Fixed

- **Statusline token-count display** reads from `context_window.total_input_tokens` and `context_window.total_output_tokens` per the v2.1.132 schema (was reading from top-level keys that the platform never emits, silently suppressing the token display on Line 2).
- **`statusline/types.py`** no longer declares phantom top-level `total_input_tokens`, `total_output_tokens`, `total_api_duration_ms` fields. These now live under their correct nested objects.

### Documentation

- **Hook output cap** clarified at 50,000 characters (was 10,000 — the figure on `docs/hooks.md:641` is out of date; changelog is authoritative).
- **New settings keys** documented in OMCA.md / CLAUDE.md: `parentSettingsBehavior`, `autoMode.hard_deny`, `autoMode.$defaults`, `worktree.symlinkDirectories`, `worktree.sparsePaths`, `sandbox.network.deniedDomains`, `statusLine.refreshInterval`.
- **New env vars** documented in OMCA.md: `CLAUDE_CODE_SESSION_ID` (Bash subprocess), `CLAUDE_EFFORT`, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`.
- **Plugin `bin/` (v2.1.91) and `monitors/` (v2.1.105) features** documented in OMCA.md `## Core Concepts`. Monitors are documented but not adopted.
- **`bin/` directory version pin** recorded in `.omca/notes/bin-directory-version-pin.md`.

### Verified (no-op confirmations)

- **H-4** `watchPaths` emission in `scripts/lifecycle-state.sh` is platform-consumed per `docs/hooks.md:1976` and `:2017`. Correctly wired on both CwdChanged and FileChanged events.
- **H-15** `alwaysLoad: true` adoption backed by reproducible startup-time bench (`servers/tests/test_startup_time.py`): warm p95=0.287s, well under the 2.0s threshold and far under the platform's 5s startup cap.
- **C-5** `scripts/agent-usage-reminder.sh` correctly unions `active-agents.json` and `subagents.json` to avoid race-window undercounts.
- **H-21** bats stderr-assertion audit: all 14 patterns in `tests/bats/hooks/` survive v2.1.98's stderr-visibility change.

### Deliberate non-adoptions

- **`maxTurns:` agent frontmatter**: attempted during this release, reverted after user observed practical issues. Color and background fields ship. Revisit when the failure mode is better understood.
- **`monitors/` plugin manifest**: documented in OMCA.md as a future-evaluation surface but explicitly NOT adopted in v2.2.0. Rationale: OMCA's current hook-based context injection covers every observed context-delivery need. Adopting would introduce a background-process surface that overlaps the hook taxonomy without a concrete demand signal.

## [2.1.0] - 2026-05-13

v2.1.0 ships three focused features that prevent the "stuck OMCA state" failure mode where `ralph` / `ultrawork` / `boulder` modes can remain active across sessions after a campaign completes, plus harden the MCP server's cold-start invariant.

### Added

- **Plan-completion auto-deactivation**: When `boulder_progress` reports `is_complete=true` AND the evidence log contains a matching F4 APPROVE entry for the active plan's SHA-256, the plugin now automatically clears `ralph`, `ultrawork`, `boulder`, and `final_verify` modes. Evidence is preserved (audit trail). Implementation extracts `_load_evidence()` and `_clear_mode_files()` helpers to `servers/tools/_common.py` so the MCP `evidence_read` tool wrapper and the new auto-deactivate path share the same loader, avoiding decorator side-effects and recursion. Fail-safe: `boulder_progress` never raises -- if `_load_evidence()` fails, the response carries `reason: "evidence_read_failed"`. F1/F2/F3 entries alone do NOT trigger auto-clear; only F4 APPROVE does. (`servers/tools/boulder.py`, `servers/tools/_common.py`, `servers/tools/evidence.py`)
- **Stale `.in_use` PID marker garbage collection at session-init**: Claude Code's plugin runtime writes `${CLAUDE_PLUGIN_ROOT}/.in_use/<pid>` markers per active session and removes them on clean exit. On crash or kill, markers strand and the `.in_use/` directory accumulates dead-PID files over time. The new `scripts/gc-in-use-markers.sh` runs as the FIRST `SessionStart` hook (before `session-init.sh`), walks the marker directory, and removes files whose PID is no longer alive. Platform-branched liveness: Linux uses `/proc/<pid>`, macOS uses `kill -0`, Windows is deferred with a `TODO(windows-liveness)` marker. Always exits 0 so GC failure cannot block session-init. (`scripts/gc-in-use-markers.sh`, `hooks/hooks.json`)
- **Startup-latency regression test for the MCP server**: New pytest test (`servers/tests/test_startup_latency.py`) times the gap between `omca-mcp.py` spawn and first `initialize` RPC reply, asserts <500ms on warm cache, skips gracefully on cold cache. Acts as a perpetual regression-guard against accidentally moving I/O-bound init (`ast_tools.discover_binary`, signal handlers, tool registration) after `mcp.run()` enters its RPC loop -- which would surface to users as transient "MCP server 'omca' not connected" PreToolUse hook errors at session start. (`servers/tests/test_startup_latency.py`)
- **Server startup-ordering invariant documentation**: `docs/design/cold-start-ordering.md` documents the audit finding that all I/O-bound init currently runs synchronously BEFORE `mcp.run()` (the correct order), and codifies the invariant for future contributors. A one-line invariant comment in `omca-mcp.py` above the `__main__` guard points at the design doc. (`docs/design/cold-start-ordering.md`, `servers/omca-mcp.py`)
- **Design notes for all three features**: `docs/design/cold-start-ordering.md`, `docs/design/stale-marker-gc.md`, `docs/design/auto-deactivate.md`. Each captures the audit / design rationale, acceptance criteria, and the closed decisions that future maintainers should not re-litigate.

### Fixed

- **Misleading `_SG_BIN` module comment**: The module-level `_SG_BIN` reference at `servers/tools/ast.py:131` previously claimed to be "set by `register()`" -- it is actually set by `set_sg_bin()` from the entry point after `discover_binary()` resolves a path. Comment now reflects reality. (`servers/tools/ast.py`)

### Tooling

- **`servers/omca-mcp.py` marked executable**: The file has a `#!/usr/bin/env python3` shebang but was tracked as non-executable in git, which the `check-shebang-scripts-are-executable` pre-commit hook now catches as Wave 2 changes touched the file. Aligned the file mode with its declared intent.

## [2.0.0] - 2026-04-24

v2.0.0 is the depth-0 orchestration cutover: `commands/` replaces orchestration skills, `executor` replaces `sisyphus-junior`, `atlas`/`socrates`/`triage` agents are removed, and the `omca-state` and `ast-grep` MCP servers are consolidated into a single `omca` server.

### Breaking Changes

- **`executor` replaces `sisyphus-junior`**: The focused-implementation agent has been renamed from `sisyphus-junior` to `executor` across all agent references, skills, and delegation tables. Update any custom configurations or saved prompts referencing `sisyphus-junior`. (`agents/executor.md`)
- **MCP server consolidation**: The separate `omca-state` and `ast-grep` MCP servers have been merged into a single unified `omca` server. Tool names are preserved, but any direct server references in `.mcp.json` overrides need updating. (`servers/`)
- **`boulder_read` / `boulder_clear` / `evidence_clear` removed**: Replaced by unified `mode_read` / `mode_clear` MCP tools. Agents and skills referencing the old tool names will receive unknown-tool errors. (`servers/omca-mcp.py`)
- **`tools:` allowlist removed from all agents**: Replaced with `disallowedTools:` to unblock MCP tool inheritance. Any agents that relied on the strict `tools:` allowlist to restrict tool access must be updated. (`agents/*.md`)
- **`atlas`, `socrates`, `triage` agents removed**: Responsibilities redistributed — `prometheus` absorbs Socratic Interview Mode; depth-0 orchestration moves to `commands/`; triage routing now handled by sisyphus delegation table. Update delegation references.
- **`notepad` `questions` section removed**: MCP schema no longer accepts `questions` as a section name. Use `issues` or `decisions` instead.
- **Release workflow changed**: `just release VERSION` now requires a CHANGELOG entry to exist before running (validates before bumping). Scripts that previously called release without a changelog entry will abort.

### Added

- **`commands/` directory with depth-0 orchestration entrypoints**: New `start-work`, `plan`, `ralph`, `ultrawork`, `ulw-loop` commands replace the corresponding skills for depth-0 orchestration. Slash commands now delegate per-task to `executor` in parallel. (`commands/`)
- **`prometheus` Socratic Interview Mode**: Prometheus now absorbs the full Socratic Interview Mode, including a 6-item clearance checklist and exploration gate for fuzzy requests before planning. (`agents/prometheus.md`)
- **`executor` agent** (renamed from `sisyphus-junior`): Cleaner identity, same role — focused implementation of known, scoped tasks. (`agents/executor.md`)
- **`plan_sha256` field on `evidence_log`**: First-class field for plan-scoped evidence verification. F1-F4 hooks now scope evidence lookup to the current plan SHA, eliminating cross-plan false-positives. (`servers/omca-mcp.py`, `scripts/task-completed-verify.sh`)
- **`file_read` MCP tool**: New tool in the omca MCP server for subagent path access outside the project root. Includes token estimation and `offset`/`limit` guidance for large-file pagination. (`servers/omca-mcp.py`)
- **Statusline per-agent thematic glyphs**: Each agent now has a dedicated NerdFont v3-compatible glyph in the statusline daemon, with a stable ASCII fallback. Includes `agent_glyph` helper and per-agent parity tests. (`statusline/`)
- **Statusline per-session socket + PID path naming**: Daemon socket and PID files now include the session ID, preventing cross-session collisions when multiple Claude Code sessions run concurrently. (`statusline/`)
- **Statusline `types`, `config`, and `protocol` modules**: Typed dataclasses and configuration layer added to the statusline package; 117 pytest tests cover the new modules. (`statusline/`)
- **`lifecycle-state.sh` for new hook events**: Handles `WorktreeCreate`, `WorktreeRemove`, `TaskCreated`, `CwdChanged`, `FileChanged` platform events. (`scripts/lifecycle-state.sh`, `hooks/hooks.json`)
- **`subagent-complete.sh` background-agent pending context injection**: Injects pending-agent context into the host session when a background subagent completes, enabling the background-agent barrier to function correctly. (`scripts/subagent-complete.sh`)
- **`if`-filtered `PermissionRequest` handlers for `rm`, `npm`, `jq`, `uv`**: Reduces permission-prompt noise for common read-only tool invocations without weakening the security guardrail. (`hooks/hooks.json`)
- **`mode_read` / `mode_clear` unified MCP tools**: Replace three separate state-read tools with a single `mode` abstraction covering ralph, ultrawork, and other persistence modes. (`servers/omca-mcp.py`)
- **BLOCKING QUESTIONS relay protocol**: Agents that cannot use `AskUserQuestion` (subagent context) now emit a structured `## BLOCKING QUESTIONS` block that sisyphus relays to the user. Documented in agent prompts and OMCA guide. (`agents/*.md`, `OMCA.md`)
- **Final-verification-evidence Stop hook + F1-F4 convention**: `task-completed-verify.sh` enforces that F1-F4 tasks have matching `evidence_log` entries before allowing plan closure. (`scripts/task-completed-verify.sh`, `hooks/hooks.json`)
- **Plan-checkbox-verify PreToolUse hook**: Prevents checkbox modifications that bypass the task-completed verification gate. (`hooks/hooks.json`)
- **`validate-plugin.sh` migration markers and hygiene checks**: Script now checks for skill description length (≤250 chars), detects migration markers, and validates component hygiene. (`scripts/validate-plugin.sh`)
- **`omca-setup` env var configuration**: Supports `OMCA_OPUS_MODEL` and agent-team environment variable configuration from the setup skill. (`skills/omca-setup/`)
- **Agent concurrency tracking and routing validation**: Hooks track active subagent count and validate that delegation routing matches the agent catalog. (`scripts/track-subagent-spawn.sh`)
- **`StopFailure` event handler**: Logs API errors to `.omca/logs/` when the session stops due to an API failure. (`scripts/`, `hooks/hooks.json`)
- **`ExitPlanMode` PermissionRequest hook**: Fires when the plan-mode classifier requests `acceptEdits` transition; injects user-approval gate. (`hooks/hooks.json`)
- **`PostToolUseFailure` handlers for Bash and Read**: Captures failure context for circuit-breaker tracking. (`hooks/hooks.json`)
- **`<coding_discipline>` block in claudemd template**: Runtime guide now includes an explicit coding discipline section injected into every session. (`templates/claudemd.md`)
- **Role-specific Memory Guidance sections in all agents**: Each agent with `memory: project` now declares role-specific save triggers and negative examples. (`agents/*.md`)
- **`hook-scratch` dev wrapper**: Utility script for ad-hoc hook testing during development without registering the hook. (`scripts/`)
- **Golden-output replay harness for shell hooks**: BATS test suite that captures and replays expected hook stdout/stderr, enabling regression detection across the full hook corpus. (`tests/bats/hooks/`)
- **BATS + pytest behavioral testing infrastructure**: End-to-end test infrastructure with lifecycle fixtures, permission-filter tests, and MCP coverage. (`tests/`)
- **Eval harness, regression fixtures**: Scaffolding for evaluating agent behavior against recorded fixture outputs. (`eval/`)
- **`agent_id` bridging in subagent tracking**: Spawn-ID from the track hook is now mapped to the platform `agent_id` for accurate cross-hook agent identification. (`scripts/track-subagent-spawn.sh`)

### Changed

- **Depth-0 orchestration pattern**: `/start-work` now runs entirely at depth 0 (main sisyphus session), spawning `executor` per task in parallel. This replaces the previous pattern where atlas/start-work skills ran as subagents. Documented in `commands/start-work.md` and `templates/claudemd.md`.
- **`prometheus` migrated to Claude-native planning surfaces**: Planning output now targets native plan mode rather than OMCA-specific plan files. Momus review and metis gap-analysis integrated into the pipeline. (`agents/prometheus.md`)
- **`metis` output constrained to native planning flow**: Output is now structured for the Claude-native plan-approval gate rather than free-form analysis. (`agents/metis.md`)
- **`momus` uses native surfaces for review state**: Review state tracked via native plan mode rather than notepad. (`agents/momus.md`)
- **Statusline daemon exponential polling backoff**: Client polling now backs off exponentially on repeated no-change responses, reducing CPU overhead during idle sessions. (`statusline/`)
- **Statusline OAuth API migrated to `rate_limits` payload**: Rate-limit data now sourced from the upstream `rate_limits` payload rather than the OAuth token endpoint, removing an auth dependency. (`statusline/`)
- **`common.sh` POSIX sidecar helpers + comment tightening**: New sidecar-path, SHA-match, and idempotency helpers extracted into `common.sh`; comment noise reduced across the library. (`scripts/lib/common.sh`)
- **Hook corpus clarity pass**: 34 shell hooks received a corpus-wide clarity pass — function naming conventions enforced (`check_*`/`validate_*` are side-effect-free; action functions use explicit verbs), magic-number derivation comments added, plan-reference comments removed. (`scripts/`)
- **`hephaestus` and `metis` tool restrictions tightened**: Both agents now use `disallowedTools:` narrowed to their specific scope, reducing accidental broad-tool use. (`agents/hephaestus.md`, `agents/metis.md`)
- **Agent metadata migrated from frontmatter to HTML comments**: Routing metadata (`<!-- omca: ... -->`) moved out of YAML frontmatter into HTML comments to avoid Claude Code frontmatter parsing conflicts. (`agents/*.md`)
- **`scripts/lib/common.sh` shared boilerplate extraction**: Repeated jq-read, atomic-write, and mode-state idioms extracted into named helpers. All scripts now source `common.sh` and use `jq_read`, `log_hook_error`, `emit_context`, etc.
- **`subagent-start.sh` restructured with agent-aware case statement**: Question-injection behavior is now per-agent rather than blanket, reducing noise for agents that handle their own output protocol. (`scripts/subagent-start.sh`)
- **`session-cleanup.sh` and `teammate-idle-guard.sh` use mode helpers**: Scripts updated to use `mode_is_active` / `mode_state_name` helpers from `common.sh`. (`scripts/`)
- **Skill bodies terse rewrite (21 skills)**: All skill bodies rewritten for conciseness — removed ceremony, redundant restatement, and thin-wrapper boilerplate. (`skills/*/SKILL.md`)
- **Agent prompts terse rewrite (planning + execution agents)**: `sisyphus`, `prometheus`, `momus`, `atlas`, `metis`, `oracle`, `explore`, `librarian`, `executor` prompts stripped of filler, metaphor intros, and redundant principle restatements. (`agents/*.md`)
- **`claudemd.md` template terse rewrite**: Token footprint reduced; `tool_routing` section converted to table format; file_reading guidance injected. (`templates/claudemd.md`)
- **`write-guard.sh` evidence handling improved**: Now correctly distinguishes evidence writes (allowed via MCP tool) from direct file writes (blocked). (`scripts/write-guard.sh`)
- **`task-completed-verify.sh` validation enhanced**: Stricter evidence freshness check; session-aware staleness short-circuits clear stale markers. (`scripts/task-completed-verify.sh`)
- **`keyword-detector.sh` and templates routed to `commands/`**: Multi-word trigger phrases updated to avoid false positives; template lookup now resolves via `commands/` directory. (`scripts/keyword-detector.sh`)
- **MCP `omca` server domain modules**: `omca-mcp.py` split into domain modules (agents, evidence, notepad, mode, file) for maintainability. (`servers/`)
- **`plugin.json` / `marketplace.json` version consistency**: Manifest version fields now validated to be in sync during release. (`scripts/validate-plugin.sh`)
- **`OMCA.md` and `README.md` updated for v2.0**: Agent catalog, workflow section, migration notes, and depth-0 orchestration pattern documented. Hardcoded component counts removed; counts are now runtime queries. (`OMCA.md`, `README.md`)
- **`CONTRIBUTING.md` hook, agent, and skill guidelines updated**: Reflects new hook `if`-field rules, `disallowedTools:` convention, and `commands/` entrypoint pattern. (`CONTRIBUTING.md`)
- **Agent AskUserQuestion soft caps removed**: Blanket turn-limit caps replaced with relay-protocol documentation; multi-call relay guidance added. (`agents/*.md`)
- **`uv` MCP server migrated to `CLAUDE_PLUGIN_DATA`**: Virtual environment now lives in the plugin data directory, persisting across plugin updates. (`servers/`)
- **`session-init.sh` conditional template injection**: Skips full `claudemd.md` template when `OMCA_CONFIGURED=1`, saving ~10K tokens per turn. (`scripts/session-init.sh`)
- **Hook `PreToolUse`/`PostToolUse` matcher narrowed from `Task|Agent` to `Agent`**: Reduces unnecessary hook firing on Task tool events. (`hooks/hooks.json`)
- **Effort frontmatter added to all agents and 14 skills**: `effort:` field added to agent and skill frontmatter for task-list cost estimation. (`agents/*.md`, `skills/*/SKILL.md`)
- **`omca-setup` skill updated**: MCP permission namespace corrected; `--doctor` mode added for diagnosing configuration issues. (`skills/omca-setup/`)
- **`maxTurns` removed from all 10 agent definitions**: Turn limits removed; agents rely on their own stop conditions and the verification protocol. (`agents/*.md`)

### Security

- **Permission filter hardened**: Compaction injection tightened; mode-conflict detection improved; `if`-field filtering added to reduce spawning overhead on tool events. (`scripts/permission-filter.sh`)

### Fixed

- **Cross-session orphan-marker false-positives in Stop hook**: The stop hook now scopes orphan-pending-final-verify marker detection to the current session, preventing stale markers from a previous session from blocking plan closure. (`scripts/stop-failure-handler.sh`)
- **`boulder_progress` counts only numbered-task checkboxes**: Was previously counting all checkboxes (including sub-bullets), inflating progress numbers. (`servers/omca-mcp.py`)
- **Auto-clear `pending-final-verify.json` on plan closure**: Plan closure now triggers automatic cleanup of the pending-verify marker, preventing stale state from blocking the next plan's verification. (`scripts/`, `hooks/hooks.json`)
- **F1-F4 enforcement skipped while background subagents are active**: Final-verification check now detects active background agents and defers enforcement until they complete, preventing false-positive blocks during parallel execution. (`scripts/task-completed-verify.sh`)
- **Plan file existence validation**: Hooks now validate that the referenced plan file exists before reading it, preventing a stale-reference cascade when a plan is deleted or renamed. (`scripts/`)
- **`consolidate-memory` reads both user and project memory scopes**: Was only reading one scope, silently missing half of saved memories. (`skills/consolidate-memory/`)
- **Statusline race-free daemon start + stale-PID stop safety**: Daemon startup now uses a lock file to prevent double-start; stale PID files are detected and cleaned up before attempting to stop. (`statusline/`)
- **ExitPlanMode sequencing after momus review**: ExitPlanMode was being called before the user-approval gate in certain skill flows, bypassing the review step. (`skills/`, `agents/`)
- **Background agent barrier extended to all background-agent launchers**: Was only applied in sisyphus; now enforced in atlas and all depth-0 orchestrators. (`agents/`, `skills/`)
- **Agent hallucinations and guardrail gaps corrected**: oracle, hephaestus, explore, and librarian received factual corrections and restored missing guardrails. (`agents/*.md`)
- **`health_check` crash on missing state files**: MCP health_check tool now handles missing `.omca/state/` files gracefully rather than raising. (`servers/omca-mcp.py`)
- **Atomic writes and `Path` fallback in MCP server**: State file writes are now atomic (tmp → mv); `Path` objects used consistently to avoid OS-level type errors. (`servers/omca-mcp.py`)
- **`permissionMode: plan` removed from `explore`, `librarian`, `oracle`**: Field is stripped by Claude Code for plugin agents; its presence caused silent misconfiguration. (`agents/*.md`)
- **Stop hook output uses top-level `decision`/`reason` fields**: Was using nested fields that the platform did not read. (`scripts/stop-failure-handler.sh`)
- **Deterministic state file creation and unified persistence blocking**: Ralph and ultrawork state files now created atomically; blocking logic unified to prevent race conditions during mode activation. (`scripts/`)
- **Two-commit SHA stamp to fix marketplace updates**: Marketplace was not picking up version bumps; release now creates version-bump commit + separate SHA-stamp commit. (`justfile`)
- **`read-error-recovery` advice updated for `file_read` MCP tool**: Skills and agents that referenced the old file-read error recovery pattern now reference the MCP tool. (`scripts/validate-plugin.sh`)
- **`permissionMode` plan-mode handler made executable**: Script lacked execute permission. (`scripts/plan-mode-handler.sh`)
- **Dead `.omca/project-memory.json` reference removed from `subagent-start`**: Reference pointed to a deleted file, causing a silent no-op in memory injection. (`scripts/subagent-start.sh`)
- **`Agent(resume=)` replaced with `SendMessage` API**: `resume=` parameter was deprecated; updated to the current SDK pattern. (`skills/`)
- **docs model reference updated**: opus model reference updated from 4 to 4-7; atlas removed from opus-tier list. (`skills/omca-setup/SKILL.md`)
- **Plugin packaging excludes dev artifacts**: `validate-plugin.sh` and `marketplace.json` now exclude `.bats`, eval fixtures, and scratch files from the distributed plugin cache. (`scripts/validate-plugin.sh`)
- **`multimodal-looker` uses `disallowedTools`**: Was using `tools:` strict allowlist which inadvertently blocked MCP tool inheritance. (`agents/multimodal-looker.md`)

### Removed

- **`atlas` agent**: Removed. Depth-0 orchestration entrypoints moved to `commands/`; sisyphus handles orchestration directly. (`agents/atlas.md` deleted)
- **`socrates` agent**: Removed. Socratic Interview Mode absorbed into `prometheus`. (`agents/socrates.md` deleted)
- **`triage` agent**: Removed. Request classification now handled by sisyphus delegation table. (`agents/triage.md` deleted)
- **Skills migrated to `commands/`**: `start-work`, `atlas`, `ralph`, `ultrawork`, `ulw-loop` skills deleted; replaced by `commands/` entrypoints with the same trigger names. (`skills/` pruned)
- **`questions` notepad section**: Removed from MCP schema; use `issues` or `decisions` for analogous content. (`servers/omca-mcp.py`)
- **Separate `omca-state` and `ast-grep` MCP servers**: Merged into unified `omca` server. Launcher scripts and separate `pyproject.toml` entries removed. (`servers/`)
- **`boulder_read`, `boulder_clear`, `evidence_clear` MCP tools**: Replaced by `mode_read` / `mode_clear`. (`servers/omca-mcp.py`)
- **`cost:` frontmatter from all agent definitions**: Deprecated field removed from all agents. (`agents/*.md`)
- **`maxTurns` from all agent definitions**: Removed; agents use their own stop conditions. (`agents/*.md`)
- **Circuit breaker tracking hooks**: Removed after simplification pass — error recovery now uses structured logging rather than a circuit-breaker state machine. (`hooks/hooks.json`, `scripts/`)
- **Hook internals leakage**: Removed debug output and internal state leakage from hook scripts that was appearing in session context. (`scripts/`)

## [1.5.2] - 2026-04-09

### Changed

- **Prompt-engineered rewrite of `templates/claudemd.md`**: The session-injected runtime
  guide has been completely rewritten as an orchestration-focused prompt. The previous
  file mixed orchestration policy with Claude Code platform trivia (env vars,
  `permissionMode` values, managed-settings reference tables, model alias lists, hook
  contracts) that Claude already knows from its host. The new file is scoped strictly to
  OMCA's responsibility — orchestration, harness, and delegation — and deletes everything
  the platform already communicates (`templates/claudemd.md`, 114 → 182 lines).
  - **New structure**: 8 XML-tagged sections — `operating_principles`, `delegation`
    decision tree, `entrypoints`, `agent_catalog`, `workflow`, `critical_rules`,
    `parallel_execution`, `verification`
  - **Second-person imperative voice** throughout; exactly 3 `IMPORTANT` markers reserved
    for true invariants (main-session must never implement plan tasks, background-agent
    barrier, evidence before completion)
  - **Delegation block** is a 17-row request-classification decision tree with an
    explicit "narrowest specialist wins" tiebreaker
  - **Agent catalog** lists all 13 specialists with model tier (opus/sonnet/haiku) and
    concrete use-when signals
  - **Fixed factual bugs**: prose version drift (old file had `v1.5.0` prose next to
    `1.5.1` frontmatter), keyword-trigger "natural interaction model" framing (contradicted
    `plugin.json`'s `enableKeywordTriggers: false` default), and unverified model aliases
    (`best`, `opusplan`, `sonnet[1m]`, `opus[1m]` not documented in Claude Code docs)
  - **Inline HTML canary markers** alongside `<agent_catalog>` and "Treat Claude Code as
    the platform owner" point future rewriters at the bats tests that depend on those
    load-bearing strings — a durable guardrail against the same rot recurring
  - Users receive the new template on their next `omca-setup` run after upgrading; the
    version-mismatch detection in `skills/omca-setup/SKILL.md` Phase 3 Step 4 handles the
    replacement automatically without manual intervention
- **Policy-marker enforcement relocated out of `templates/claudemd.md`**: The 4
  managed-settings markers (`teammateMode: "auto"`, `allowManagedPermissionRulesOnly`,
  `sandbox.failIfUnavailable`, permission-filter non-bypass disclosure) are no longer
  enforced in the template — they live only in `OMCA.md` (user-facing reference) and
  `skills/omca-setup/SKILL.md` (install-time guidance), where the managed-settings
  posture actually belongs. The now-unused `TEMPLATE_CLAUDEMD_MD` constant is also
  removed (`scripts/validate-plugin.sh`)
- **Contributor docs synced with new template structure**: `docs/CONTRIBUTING.md`
  agent-addition instructions updated from "catalog table" → "`<agent_catalog>` block";
  `justfile` `new-agent` recipe echo cleaned of the stale `agent-metadata.json`
  reference (that file was already removed per `validate-plugin.sh:652-657`)
- **Pre-commit hook scope aligned with `just lint-shell`**: `.bats` files are now
  excluded from the `check-shebang-scripts-are-executable` and `shellcheck` pre-commit
  hooks. `just lint-shell` only lints `scripts/*.sh`; the pre-commit hooks previously
  over-reached by running shellcheck on bats files (detected via the `#!/usr/bin/env bats`
  shebang), which would flag pre-existing style patterns — SC2250 unbraced variables and
  SC2002 useless-cat — that the project has consistently accepted across all 11 bats
  files. Bats files are still validated at test time by `bats` itself and via
  `just test-bats` (`.pre-commit-config.yaml`)

### Fixed

- **Dead bats canary in `tests/bats/hooks/session_lifecycle.bats`**: The
  "skips full template when CLAUDE.md has omca-setup" test was keyed to `## Agent Catalog`,
  a markdown header that existed in the old `templates/claudemd.md`. When the
  prompt-engineered rewrite replaced that header with `<agent_catalog>` XML tags, the
  canary silently weakened: the assertion still passed, but only because the string it
  was checking for no longer existed anywhere in the codebase — the test was no longer
  verifying what it was designed to verify. Replaced with two orthogonal canary
  assertions keyed to structurally stable signals in the new template (`<agent_catalog>`
  XML tag and the "Treat Claude Code as the platform owner" operating principle). Using
  two keys means a future template rewrite would have to kill BOTH strings to silently
  rot the canary again. Found by retrospective oracle review of the template rewrite via
  the prometheus workflow (`tests/bats/hooks/session_lifecycle.bats`)

## [1.5.1] - 2026-04-08

### Changed

- **Platform sync for Claude Code v2.1.83–v2.1.94**: Template, rules, and README updated
  with new platform features — `dontAsk` permission mode, `opusplan`/`best` model aliases,
  `ENABLE_TOOL_SEARCH` env var, 10K hook output cap, `plansDirectory` setting,
  `CLAUDE.local.md` scope, `sessionTitle` hook output, `disableSkillShellExecution` managed
  setting, GHES plugin marketplace git URL syntax (`templates/claudemd.md`, `README.md`,
  `scripts/session-init.sh`)
- **OMCA guide rewrite**: Condensed `OMCA.md` from ~1,400 lines to a focused runtime
  reference aligned with v1.5.0 hard-cutover model (`OMCA.md`, `templates/claudemd.md`)
- **Pipeline hardening**: Added user-approval gate to planning pipeline documentation and
  safety logging to ExitPlanMode hook (`scripts/plan-mode-handler.sh`)

### Fixed

- **ExitPlanMode safety gate**: Prometheus and momus agents now gate ExitPlanMode behind
  AskUserQuestion to prevent plan auto-approval without user consent
  (`agents/prometheus.md`, `skills/prometheus-plan/SKILL.md`)

## [1.5.0] - 2026-04-02

### Added

- **Background agent barrier**: SubagentStop hook now injects `additionalContext` when
  other agents are still running, telling the orchestrator to wait instead of acting on
  partial results. Barrier instructions added to all agents and skills that launch
  background agents (`subagent-complete.sh`, `sisyphus.md`, `atlas.md`, `socrates.md`,
  `sisyphus-junior.md`, `github-triage`, `init-deep`, `ultrawork`)
- **New hook events**: `TaskCreated`, `CwdChanged`, `FileChanged`, `WorktreeCreate`,
  `WorktreeRemove` — lifecycle tracking via `lifecycle-state.sh`
- **If-filtered permission handlers**: `PermissionRequest` hooks for `rm`, `npm`, `jq`,
  `uv` with argument-level `if` field filtering to reduce process spawning overhead
- **Output styles**: plugin-level output style system with `pluginConfigs` defaults and
  `userConfig` schema
- **Filesystem read tool**: `file_read` MCP tool for subagent path access outside project
  root, bypassing sandbox scoping
- **Claude-Native Orchestration Contract**: sisyphus and atlas agents now document the
  boundary between OMCA policy and Claude-native surfaces (TaskCreated/TaskCompleted/
  TeammateIdle governance)
- **Mode state helpers**: `_mode_is_active`, `_mode_state_name`, `_mode_state_path` in
  `common.sh` — shared boilerplate for mode detection across hook scripts
- **Skill enhancements**: `paths:` frontmatter field, `shell:` field for atlas/handoff/
  start-work, updated prometheus-plan and omca-setup for Claude-native planning
- **Behavioral testing**: BATS + pytest infrastructure with fixtures for hook events,
  permission filtering, and MCP tool validation

### Changed

- **Agent metadata migration**: all 13 agents moved cost/category/escalation metadata
  from YAML frontmatter to HTML comments, eliminating platform-visible noise
- **Prometheus/Metis/Momus**: migrated to Claude-native planning surfaces — plans and
  review state use native plan files, not `.omca/` wrappers
- **Subagent-start.sh restructure**: refactored context injection with section headers,
  catalog injection for orchestrators, anti-duplication guidance, and external access
  guidance
- **Task-completed-verify.sh**: enhanced validation with stricter evidence schema checking
- **Write-guard.sh**: improved evidence file handling
- **PreToolUse matcher**: narrowed from `Task|Agent` to `Agent` only (Task tool was
  renamed to Agent in Claude Code v2.1.63)
- **Agent catalog simplification**: removed legacy `agent-metadata.json` server file;
  catalog is now generated dynamically from agent frontmatter
- **Mode state refactor**: `teammate-idle-guard.sh`, `stop-failure-handler.sh`,
  `pre-compact.sh`, `session-cleanup.sh` refactored to use shared `_mode_is_active`
  helper

### Fixed

- **Background agent notification stalls**: orchestrator agents now correctly wait for
  all background agent notifications instead of acting on partial results — the "Esc to
  flush" bug where queued task-notifications wouldn't trigger new turns
- **MCP tool inheritance**: removed `allowed-tools` from skills that was blocking MCP
  tool inheritance in subagents
- **Read error recovery**: updated advice to reference `file_read` MCP tool instead of
  `Bash(cat ...)`
- **Multimodal-looker constraints**: added binary and device file constraints to prevent
  invalid file reads

[1.5.2]: https://github.com/UtsavBalar1231/oh-my-claudeagent/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/UtsavBalar1231/oh-my-claudeagent/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/UtsavBalar1231/oh-my-claudeagent/compare/v1.4.1...v1.5.0

## [1.4.1] - 2026-03-25

### Added

- **Time awareness injection**: Session context now includes a `[CURRENT DATE]` block so Claude
  knows the current date and doesn't default to stale training data. Date survives compaction
  via fresh re-injection, and subagents receive a lightweight date-only variant. Uses `LC_TIME=C`
  for POSIX-portable, locale-independent output with graceful degradation
  (`session-init.sh`, `post-compact-inject.sh`, `subagent-start.sh`)

### Changed

- **Hook output markers and section headers**: Multi-block `additionalContext` output now uses
  `─── Section ─────` headers and `$'\n'` newline separators instead of space concatenation.
  `subagent-start.sh` groups its 10+ context blocks into scannable sections (Agent Protocol,
  Active Modes, Plan Context, Execution Guidance, External Access, Agent Catalog). Added
  `_section_header()` utility to `scripts/lib/common.sh` for consistent formatting.
  `keyword-detector.sh` and `context-injector.sh` also use newline separation

### Fixed

- **Explore agent Bash permissions**: Removed `permissionMode: plan` from explore, librarian,
  and oracle agents to fix Bash being blocked for external file access. Read-only safety is
  now enforced via `disallowedTools: Write, Edit, Agent` plus an explicit Bash Usage Policy
  section in each agent. Triage and multimodal-looker retain `permissionMode: plan`

[1.4.1]: https://github.com/UtsavBalar1231/oh-my-claudeagent/compare/v1.4.0...v1.4.1

## [1.4.0] - 2026-03-24

### Added

- **Triage agent**: lightweight request classifier for routing simple vs complex tasks
  (`agents/triage.md`)
- **Eval harness**: regression fixtures and documentation for quality assurance
  (`docs/eval/`, `tests/fixtures/`)
- **DX scaffolding recipes**: `just new-agent NAME`, `just new-hook EVENT NAME`,
  CI validation improvements, and `just smoke-test` shortcut
- **Observability hooks**: async conversion for `post-edit.sh` and
  `instructions-loaded-audit.sh`, performance instrumentation
- **MCP improvements**: `health_check` and `notepad_compact` tools, improved tool
  descriptions and annotations
- **PostToolUseFailure handlers**: `bash-error-recovery.sh` and `read-error-recovery.sh`
  for Bash and Read tool error recovery
- **Security hardening**: improved permission filter patterns, compaction injection
  safety, mode conflict detection
- **Agent enhancements**: agentic reminders, effort scaling guidance, sandwich defense
  patterns

### Changed

- **MCP server refactor**: split monolithic `omca-mcp.py` into domain modules
  (`servers/tools/ast.py`, `boulder.py`, `catalog.py`, `evidence.py`, `notepad.py`)
- **Hook boilerplate extraction**: shared utilities extracted to `scripts/lib/common.sh`
- **Agent routing metadata**: migrated to frontmatter fields
- **Agent tone**: softened aggressive language, removed unnecessary personas
- **Token efficiency**: reduced `templates/claudemd.md` token footprint
- **Error recovery**: simplified PostToolUseFailure handlers, polished hook scripts
- **Documentation**: removed hardcoded component counts from OMCA.md and README.md for
  maintainability

### Fixed

- **Agent hallucinations**: corrected factual errors in agent definitions, restored
  guardrails and consistency checks
- **Hook tracking**: agent tracking field mismatch, race condition in spawn tracking,
  keyword gate reliability
- **MCP stability**: `health_check` crash, atomic write safety, `Path` fallback, stale
  tool descriptions
- **Plan-mode subagents**: injected external path access guidance for plan-mode agents
- **Documentation**: restored template sections, fixed eval docs formatting

[1.4.0]: https://github.com/UtsavBalar1231/oh-my-claudeagent/compare/v1.3.0...v1.4.0

## [1.3.0] - 2026-03-22

### Added

- **StopFailure hook event handler**: new `stop-failure-handler.sh` logs API errors
  (rate limit, auth failure, billing, server error) to `.omca/logs/stop-failures.jsonl`.
  Emits warning when ralph/ultrawork persistence mode was interrupted. StopFailure output
  and exit code are ignored by Claude Code — this is a permanent known limitation for
  persistence modes (users must manually resume after API errors)
- **Effort frontmatter for agents**: all 10 agents gain `effort:` field — oracle=max,
  opus agents=high, sonnet agents=medium. Overrides session effort level per agent for
  cost/quality tuning
- **Effort frontmatter for skills**: 14 of 20 skills gain `effort:` field — 9 high
  (planning/execution skills), 5 medium (moderate complexity)
- **CLAUDE_PLUGIN_DATA venv migration**: MCP server Python dependencies now persist across
  plugin updates via `UV_PROJECT_ENVIRONMENT` in `.mcp.json` env and diff-based sync in
  `session-init.sh`. Falls back to in-plugin venv on older Claude Code versions
- **validate-plugin justfile recipe**: `just validate-plugin` runs `claude plugin validate .`
  with `command -v claude` guard. Standalone recipe, not part of `just ci`
- **ADR-017**: upstream port assessment for Claude Code v2.1.78-v2.1.81 documenting all
  22 action items from the 47 changed upstream doc files
- **Ultrawork Stop hook test scenarios**: additional test assertions for ralph-persistence
  behavior under ultrawork mode
- **SessionEnd test fixtures**: `sessionend-resume.json` and `sessionend-normal.json`
- **Documentation updates**: StopFailure in hook map (18 event types, 28 hook commands,
  29 scripts), `@-mention` subagent invocation syntax, channels feature awareness,
  `--bare` flag, sandbox path prefix changes, enterprise settings, compound command
  permission splitting, new env vars, global config split to `~/.claude.json`,
  `disallowedTools` + `tools` interaction, `source: 'settings'` inline marketplace

### Changed

- **Statusline: OAuth API replaced by upstream payload**: deleted `usage.py` (288 LOC) —
  the custom OAuth API client with HTTP fetch, caching, circuit breaker, and keychain
  token extraction. Rate limit data now comes free from Claude Code's statusline JSON
  payload (`rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage`).
  Trade-off: lost `seven_day_sonnet` and `extra_usage.is_enabled` (minor)
- **MCP tool renames**: `boulder_read`/`boulder_clear`/`evidence_clear` replaced by
  unified `mode_read`/`mode_clear`
- **ADR-012 adoption roadmap**: 6 new entries (effort, PLUGIN_DATA, StopFailure,
  InstructionsLoaded matchers, PostCompact matchers, background). maxTurns corrected
  from "Adopted (all agents)" to "Available but not adopted — causes subagent issues"
- **SessionEnd cleanup**: `session-cleanup.sh` now reads stdin JSON and skips heavy
  cleanup (log pruning, old file deletion) when `reason == "resume"` — lighter behavior
  for session switching via interactive `/resume`

### Fixed

- **Spawn-ID bridging**: `track-subagent-spawn.sh` now bridges spawn-ID to platform
  `agent_id` in subagent tracking
- **teammate-idle-guard**: corrected field names and use `started_epoch` for staleness
- **Ultrawork stagnation**: improved detection and agent-aware idle stop behavior
- **Sisyphus background results**: added collection guidance for background agent results
- **Plan Mode Exit**: agents gain guidance to prevent premature ExitPlanMode calls
- **ExitPlanMode sequencing**: restructured in skills after momus review
- **State cleanup**: replaced `rm -f` with `mode_clear` MCP tool in skill scripts

[1.3.0]: https://github.com/UtsavBalar1231/oh-my-claudeagent/compare/v1.2.2...v1.3.0

## [1.2.2] - 2026-03-19

### Fixed

- **Stop hook JSON schema validation**: `ralph-persistence.sh` now uses top-level
  `{"decision":"block","reason":"..."}` instead of the `hookSpecificOutput` wrapper.
  Claude Code only accepts `hookSpecificOutput` for PreToolUse, UserPromptSubmit, and
  PostToolUse events — Stop events require top-level fields. This was causing
  `Hook JSON output validation failed: Invalid input` errors that silently broke
  ralph/ultrawork persistence

### Changed

- **Hook Script Conventions docs**: CLAUDE.md now documents format-by-event-type
  (hookSpecificOutput vs top-level decision/reason vs exit code 2) instead of
  implying all hooks use the same output wrapper

[1.2.2]: https://github.com/UtsavBalar1231/oh-my-claudeagent/compare/v1.2.1...v1.2.2

## [1.2.1] - 2026-03-19

### Fixed

- **Deterministic persistence state files**: `keyword-detector.sh` now creates
  `ralph-state.json` and `ultrawork-state.json` atomically on keyword detection,
  removing the dependency on Claude voluntarily following skill instructions
- **Unified Stop blocking for ultrawork**: `ralph-persistence.sh` now checks both
  `ralph-state.json` and `ultrawork-state.json` — ultrawork mode previously had
  zero Stop-event enforcement
- **Boulder fallback for task tracking gap**: when `ralph-state.json` has no tasks
  (Claude used native TaskCreate instead of syncing), the Stop hook falls back to
  `boulder.json` active plan detection with a 15-minute staleness guard
- **Variable stagnation threshold**: empty task arrays use threshold 5 (more runway)
  vs 3 for populated arrays, preventing premature stop when tasks are tracked natively

### Added

- **Persistence test fixtures**: `userpromptsubmit-ralph.json`,
  `userpromptsubmit-ultrawork.json`, `stop-basic.json` with 6 new validation
  assertions in `validate-plugin.sh`
- **State file sync instructions in ralph SKILL**: explicit jq commands for syncing
  `TaskCreate`/`TaskUpdate` to `ralph-state.json`
- **State files section in ultrawork SKILL**: documents `ultrawork-state.json`
  lifecycle and cleanup

### Changed

- **stop-continuation now clears ultrawork state**: previously only cleared
  `ralph-state.json` and `boulder.json`, leaving `ultrawork-state.json` orphaned
- **cancel-ralph documents scope**: added note that it only cancels ralph mode,
  directing users to `stop-continuation` for ultrawork cleanup

[1.2.1]: https://github.com/UtsavBalar1231/oh-my-claudeagent/compare/v1.2.0...v1.2.1

## [1.2.0] - 2026-03-18

### Added

- **Subagent output mandate**: SubagentStart hook injects `[OUTPUT MANDATE]` into all
  depth-1 agents, telling them their text response is the only output the orchestrator
  receives. Prevents agents from exhausting turns on tool calls without synthesizing
- **Output failure conditions**: 7 agents (oracle, metis, momus, librarian, socrates,
  atlas, sisyphus) gain "Output Requirements (CRITICAL)" sections with explicit failure
  conditions modeled on explore's pattern — the only agent that reliably produced output
- **ExitPlanMode permission hook**: new `plan-mode-handler.sh` auto-transitions session
  to `acceptEdits` on plan approval, enabling execution agents to write files after
  plan mode exit
- **OMCA.md comprehensive guide**: 1200+ line operational guide consolidating plugin
  architecture, agent catalog, skill reference, and hook documentation
- **Statusline package docs**: added `statusline/README.md` with installation,
  configuration, and architecture documentation
- **Release version argument**: `just release [version]` accepts optional version to
  bump all manifests in one command
- **ExitPlanMode test fixture**: added `permissionrequest-exitplanmode.json` for hook
  validation

### Changed

- **Removed maxTurns from all 10 agents**: agents manage their own turn budget instead
  of hard cutoffs; output mandate and failure conditions provide the safety net
- **Improved empty-task-response detection**: threshold raised from 10 to 50 chars,
  added transitional pattern regex (detects "Let me...", "I'll...", etc. in short
  responses), improved warning with SendMessage resumption guidance
- **Code quality sweep across agents**: normalized content headers, MCP param names
  (`type` → `evidence_type`, `yaml` → `rule_yaml`, `dryRun` → `dry_run`), removed
  deprecated `cost` frontmatter from all agent definitions
- **Code quality sweep across scripts**: hardened hook scripts with consistent error
  handling, fixed delegate-retry `hookEventName` field, improved notify.sh multiline
  handling
- **Skills cleanup**: removed redundant separators, fixed param names, trimmed content
  across atlas, dev-browser, frontend-ui-ux, git-master, handoff, hephaestus, ralph,
  refactor, ultrawork, ulw-loop skills
- **MCP server simplification**: refactored ast-grep and omca-state servers for clarity,
  reformatted type annotations
- **MCP consolidation**: merged root `pyproject.toml` into `servers/pyproject.toml`,
  removed launcher scripts (`start-ast-grep-server.sh`, `start-omca-state-server.sh`),
  updated `.mcp.json` to use `uv run --project servers` directly
- **README trimmed to landing page**: moved detailed docs to OMCA.md, README now serves
  as quick-start entry point
- **Updated SendMessage API**: replaced deprecated `Agent(resume=)` with
  `SendMessage({to: agentId})` across agent definitions
- **Evidence enforcement**: `write-guard.sh` and `task-completed-verify.sh` now reject
  manual writes to `verification-evidence.json`, requiring `evidence_log` MCP tool
- **CI workflow updates**: bumped the all-actions group (checkout, setup-python,
  cache) via Dependabot

### Fixed

- Removed dead `.omca/project-memory.json` reference from subagent-start hook
- Added executable permission to `plan-mode-handler.sh`
- Synced pyproject.toml and claudemd.md versions to match plugin.json (were out of
  sync after v1.1.0 release)
- Fixed release recipe to sync version into `servers/pyproject.toml` and
  `templates/claudemd.md`

[1.2.0]: https://github.com/UtsavBalar1231/oh-my-claudeagent/compare/v1.1.0...v1.2.0

## [1.1.0] - 2026-03-17

### Added

- **Statusline usage bars**: OAuth usage API client (`statusline/usage.py`) fetches
  five-hour and seven-day utilization percentages from the Anthropic API with disk
  cache (300s TTL), circuit breaker with exponential backoff (caps at 3600s), and
  opt-out via `CLAUDE_STATUSLINE_NO_USAGE`. Rendered as a third statusline row with
  ▰/▱ bars, color-coded thresholds, and local reset timestamps. Daemon caches usage
  in a background thread; direct and client modes call inline
- **New skills**: github-triage (read-only issue/PR triage with per-item background
  agents and evidence-backed reports) and ulw-loop (ralph + ultrawork + oracle
  verification persistence loop)
- **Plan mode support**: prometheus-plan, sisyphus-orchestrate, and start-work skills
  detect plan mode and document behavior. ExitPlanMode tool added to atlas, sisyphus,
  and prometheus. Atlas and metis gain `permissionMode: acceptEdits` for execution
  from plan mode
- **Ralph stagnation detection**: tracks task-state hash across stop attempts; allows
  exit after 3 consecutive identical checks to prevent infinite loops
- **Ralph question-aware stopping**: allows stop when an AskUserQuestion is pending
  (within 5 minutes) so the user can respond
- **Pending-question tracking**: new `track-question.sh` PostToolUse hook records
  AskUserQuestion calls to `.omca/state/pending-question.json`
- **Keyword detector i18n**: Korean, Japanese, and Chinese pattern matching for ralph
  and ultrawork keyword triggers
- **Keyword detector subagent skip**: skips keyword detection when running inside a
  subagent session (checks `agent_id` in hook payload)
- **Pre-compact agent resume**: includes recently spawned agents in compaction context
  with `RESUME, DON'T RESTART` directive to prevent duplicate spawns after compaction
- **Delegate-retry retryable errors**: detects rate limits, timeouts, and capacity
  errors and suggests retry instead of oracle escalation

### Changed

- **atlas**: replaced QA protocol with notepad protocol; added anti-duplication rule,
  auto-continue policy (no user approval between tasks), verification evidence table,
  and mandatory manual code review step
- **prometheus**: added anti-duplication rule, draft-as-memory system
  (`.omca/drafts/` as working memory across turns), and turn termination rules
  (every response must end with a question, draft update, wait, or transition)
- **sisyphus**: added anti-duplication rule and intent verbalization step (Step 1.5:
  verbalize intent before routing)
- **sisyphus-junior**: added structured escalation format and background agent results
  handling
- **metis**: added QA automation directives (agent-executable criteria only) and
  AI-slop pattern detection (scope inflation, premature abstraction, over-validation)
- **momus**: added approval bias philosophy (approve when 80% clear), max 3 issues
  per rejection, and file-path invocation requirement
- **oracle**: added output verbosity limits (≤7 action steps, ≤4 bullets) and
  high-risk self-check (unstated assumptions, overly strong language)
- **socrates**: added plan context awareness (boulder_read, notepad) and evidence
  quality rules (2+ sources, confidence tagging)
- **librarian**: added plan context awareness and escalation guidance (recommend
  implementation agents for code changes, oracle for architecture)
- Simplified agent-usage-reminder counter logic (modulo-3 instead of reset-to-zero)
- Reformatted type annotations in omca-state-server
- Refactored statusline progress bars from graduated blocks to uniform ▰/▱ symbols
  with shared `_render_bar()` helper

### Fixed

- Removed stale `mcp__pgs__*` permission entries from omca-setup skill
- Hardened permission-filter regex to catch `rm -fr`, `sudo rm` variants (was only
  matching `rm -rf` and `rm -r`)
- Fixed notify.sh multiline string handling (strips newlines before passing to
  osascript `display notification`)
- Added macOS/BSD portability for `stat` and `date` commands; suppressed SC2312
  shellcheck warnings
- Fixed git-master skill phase numbering gap (renumbered phases)
- Fixed delegate-retry missing `hookEventName` field and `ERROR_TEXT` fallback chain
- Removed fallback default from plugin root path configuration
- Set valid SHA in marketplace plugin source for schema validation
- Made `track-question.sh` executable

[1.1.0]: https://github.com/UtsavBalar1231/oh-my-claudeagent/compare/v1.0.0...v1.1.0

## [1.0.0] - 2026-03-15

Initial public release of oh-my-claudeagent — a markdown-first Claude Code plugin
for multi-agent orchestration.

### Added

- 12 specialist agents (Greek mythology names): sisyphus, atlas, prometheus, metis,
  momus, oracle, sisyphus-junior, explore, librarian, hephaestus, multimodal-looker,
  socrates
- 18 skills including ralph persistence, ultrawork parallel execution, handoff,
  git-master, frontend-ui-ux, and agent command skills (atlas, metis, prometheus-plan,
  hephaestus, sisyphus-orchestrate)
- ast-grep MCP server wrapping `sg` CLI for structural code search and transformation
- omca-state MCP server with boulder (work plan tracking), evidence (verification),
  and notepad (subagent learning) management
- 17 hook event types across 25 hook commands covering session lifecycle, tool
  lifecycle, agent lifecycle, and infrastructure events
- PostCompact log hook for compaction observability
- Keyword detection system with auto-activation of skills and modes
- Ralph persistence loop — blocks session stop until verified complete
- Context injection on file read (AGENTS.md, README.md, .omca/rules/)
- Compaction survival pipeline (PreCompact save → PostCompact enrich → SessionStart re-inject)
- Agent tracking pipeline across PreToolUse → SubagentStart → SubagentStop
- Permission auto-approval for package managers, denial for destructive `rm -rf`
- Notepad injection and plan-file protection in SubagentStart hook
- Plugin validation harness and contract test fixtures
- GitHub Actions CI and release workflows
- Dependabot configuration for automated dependency updates
- Project quality tooling (EditorConfig, ruff, shellcheck)

### Fixed

- Stop hook output format and `hookEventName` field name mismatch
- Boulder field name (`.planFile` → `.active_plan`) in subagent-start and pre-compact hooks
- Marketplace source path in schema definition
- ast-grep bootstrap diagnostics and error reporting
- Hook permission handling and lifecycle edge cases
- LSP capability provenance clarified as host-provided in agent definitions
- Skill setup, provenance checks, and capability boundary enforcement
- Executable permissions on all hook and utility scripts
- Orphaned keyword removal, safe fallback defaults, and JSON escaping
- Single-read pattern, consistent `jq` arguments, and UTF-8 safe truncation
- Delegation reminder suppression inside subagent contexts
- Context injection rules extended to Write and Edit events (not just Read)
- `CLAUDE_PLUGIN_ROOT` fallback for MCP server commands

### Changed

- README and runtime template rewritten for public release
- Dead worktree scripts removed; utility launchers documented
- Shellcheck fixes applied across all hook scripts
- Ruff fixes applied to Python MCP servers

[1.0.0]: https://github.com/UtsavBalar1231/oh-my-claudeagent/releases/tag/v1.0.0
