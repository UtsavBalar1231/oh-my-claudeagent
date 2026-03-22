# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-03-22

### Added

- **StopFailure hook event handler**: new `stop-failure-handler.sh` logs API errors
  (rate limit, auth failure, billing, server error) to `.omca/logs/stop-failures.jsonl`.
  Emits warning when ralph/ultrawork persistence mode was interrupted. StopFailure output
  and exit code are ignored by Claude Code — this is a permanent known limitation for
  persistence modes (users must manually resume after API errors)
- **Effort frontmatter for agents**: all 12 agents gain `effort:` field — oracle=max,
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

- **Removed maxTurns from all 12 agents**: agents manage their own turn budget instead
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
