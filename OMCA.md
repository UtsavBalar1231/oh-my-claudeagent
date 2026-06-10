# oh-my-claudeagent — Complete Guide

Plugin for Claude Code adding multi-agent orchestration: specialist agents, slash-command/keyword skills, hook-driven persistence, MCP servers for structural search and state tracking.

Install: `README.md`. Contributor internals: `CLAUDE.md`.

---

## What Is This

Claude Code runs single-threaded. Simultaneous research + implementation, or ten files needing fixes at once, bottleneck the default session. No built-in specialist delegation or persistence guarantee.

OMCA adds a multi-agent layer: specialist agents with model tiers (claude-fable-5[1m]/sonnet/haiku), skills via slash commands or keywords, hooks for persistence and context injection, MCP servers for structural search and state.

### Philosophy

Delegate to specialists, verify with evidence, ship with confidence. Core loop: explore → plan → execute in parallel → verify. Every agent delegates or implements — never both. Every claim requires evidence.

---

## Ownership Model

**Claude-native**: plan mode, memory, hooks, plugin schema, permissions, sandboxing, subagents, teams, `claude agents` agent view (Research Preview, v2.1.139+), `/goal` completion-condition loop (v2.1.139+).

**OMCA**: agent prompts, orchestration policy, skill prompts, keyword activation, verification discipline, `omca` MCP server, session persistence (ralph, ultrawork), execution metadata in `.omca/state/` and `.omca/logs/`.

Claude-native plans (`~/.claude/plans/` or the active plan-mode file) are canonical. `.omca/plans/` remains a supported compatibility mirror/resume surface maintained by boulder, not the primary authored plan surface.

**`/goal` vs OMCA persistence loops**: `/goal` is a lighter-weight native completion-condition loop. OMCA's `ralph`, `ultrawork`, and `/oh-my-claudeagent:ulw-loop` carry the Final Verification Wave (F1-F4 evidence-discipline) that `/goal` does not. Use `/goal` for quick "keep working until X" tasks; use OMCA loops when work needs evidence-gated completion.

**Channels**: Not used — OMCA focuses on in-session orchestration via hooks, subagents, skills.

---

## Core Concepts

### Agents

Markdown files in `agents/*.md` with YAML frontmatter (name, model, disallowedTools, behavior). Addressable via `Agent(subagent_type="oh-my-claudeagent:NAME")`.

**Model tiers:**

| Tier | Default for | Use for |
|------|-------------|---------|
| claude-fable-5[1m] | Orchestrators, planners, reviewers | Complex reasoning, architecture, multi-step coordination |
| sonnet | Executors, searchers, fixers | Standard implementation, search, builds |
| haiku | (override only) | Quick lookups, simple transforms |

Override any agent's model: `Agent(subagent_type="oh-my-claudeagent:explore", model="haiku")`

**Delegation chain:** Depth 1 subagents cannot spawn further subagents — `Agent` tool stripped.

```
main session (sisyphus identity, depth 0, full Agent tool)
  -> worker (depth 1, via Agent() — terminal)
```

The orchestrator (`sisyphus`) is the main-session identity injected via
`templates/claudemd.md`. Plan-driven execution is triggered via
`/oh-my-claudeagent:start-work` — a slash command that runs inline in the main session
at depth 0 with full Agent-tool access (its body carries the Plan Execution Mode
protocol). No `context: fork` skill intermediates between user and orchestrator.

**Permission inheritance:** Plugin subagents inherit the parent session's permission mode,
including auto mode. `permissionMode` in agent frontmatter is stripped by Claude Code for
plugin agents. To retain `permissionMode`, copy agent files to `~/.claude/agents/`
(user-scope agents retain it).

**`initialPrompt` in agent frontmatter (v2.1.141–v2.1.167, not adopted):**

Agent files can declare an `initialPrompt:` field that fires an unconditional model turn
at session start, before any user message. OMCA does not adopt this because
`scripts/subagent-start.sh` already injects boulder plan context and mode banners as
`additionalContext` on `SubagentStart` — the same information at zero model-turn cost.
Adding an `initialPrompt` would consume a billable turn per subagent instantiation with
no new information benefit.

**Plugin-agent frontmatter restrictions (v2.1.154+):** Claude Code silently ignores
`hooks`, `mcpServers`, and `permissionMode` in agent frontmatter for plugin-shipped
agents (i.e., agents in the plugin's `agents/` directory). No OMCA agent currently
declares any of these fields. If you need an agent that uses custom hooks, extra MCP
servers, or a specific permission mode, copy that agent file to `~/.claude/agents/`
(user-scope) or `.claude/agents/` (project-scope) — agents at those paths are not
plugin-managed and have no frontmatter restrictions.

**Lean system prompt default (v2.1.154):**

New subagents receive a shorter system prompt by default. Agents with detailed
instructions in their frontmatter `description:` / body are unaffected. OMCA agent
definitions are self-contained and already carry their full instruction sets.

**`subagent_type` matching (v2.1.140):**

`Agent(subagent_type=...)` matching is case- and separator-insensitive as of v2.1.140.
`"oh-my-claudeagent:executor"`, `"oh-my-claudeagent:Executor"`, and
`"oh-my-claudeagent_executor"` all resolve to the same agent. OMCA uses consistent
lowercase colon-separated names throughout; this change is backward-compatible.

**Inline agent `mcpServers` — strict-mcp policy (v2.1.153):**

For inline agents that declare `mcpServers` in their frontmatter, Claude Code now
enforces the session's strict-mcp policy (e.g., `allowManagedMcpServersOnly`). No OMCA
agent declares `mcpServers` frontmatter (confirmed by grep); this change has no
behavioral impact on OMCA.

**Multiple `Agent(...)` types in `tools:` frontmatter (v2.1.147):**

A platform bug was fixed in v2.1.147 where listing multiple agent types in a skill's
`tools:` frontmatter would cause only the first to be recognized. OMCA skills that
declare `tools: [Agent(...)]` are unaffected — no OMCA skill lists multiple Agent types.

**Model resolution order:** `CLAUDE_CODE_SUBAGENT_MODEL` env > per-invocation model >
agent frontmatter model > main session. Warning: setting `CLAUDE_CODE_SUBAGENT_MODEL`
globally overrides all agent model tiers.

### Skills

Skills are directories in `skills/*/SKILL.md`. They can be invoked two ways:

- **Slash commands:** `/oh-my-claudeagent:NAME` in any Claude Code session
- **Keywords:** Natural phrases typed in any prompt auto-activate certain skills

Skills support a `paths:` frontmatter field with glob patterns for file-specific
auto-activation (e.g., `paths: ["**/*.tsx"]` activates a skill when matching files are
opened).

Two execution modes:

- **Direct skills** — the SKILL.md IS the agent prompt, runs in the current session
- **`context: fork` skills** — forks into a fresh agent context with full tool access

Keywords are the natural interaction model. Type "create plan", "ralph don't stop", or
"ultrawork" in any prompt and the corresponding skill activates automatically. Slash
commands are also available for explicit invocation.

**`disallowed-tools` frontmatter (v2.1.152):**

SKILL.md files can declare a `disallowed-tools:` list in their frontmatter to prevent
specific tools from being available when the skill runs. OMCA adopts this on two skills:

| Skill | disallowed-tools | Reason |
|-------|-----------------|--------|
| `github-triage` | `[Write, Edit]` | Orchestrator skill is read-only; reports are written by spawned executor subagents |
| `hephaestus` | `[Agent]` | Forked specialist must not delegate; fix loop is solo |

For `context: fork` skills bound to a named agent via `agent:` frontmatter (e.g., metis,
momus), skill-level `disallowed-tools` is redundant — the agent definition already
enforces `disallowedTools` at the agent-config layer. The skill layer only matters for
skills running in the main session without an `agent:` binding.

**`arguments:` frontmatter (v2.1.141–v2.1.167, not adopted):**

Skills can declare an `arguments:` block in their frontmatter to name positional parameters
that the platform binds when the skill is invoked as a slash command with trailing text
(e.g., `/oh-my-claudeagent:ralph fix the auth bug` → `$task="fix"`). OMCA does not adopt
`arguments:` because shell-style positional binding truncates free-form input: only the
first token is bound, making it unsuitable for narrative task descriptions. OMCA skill
bodies receive the full user prompt via the platform's natural expansion path instead.

**`hooks:` frontmatter (v2.1.141–v2.1.167, not adopted):**

SKILL.md files can declare a `hooks:` block to register hook handlers that are active
only while the skill is running. OMCA does not adopt this because OMCA's persistence
loops (ralph, ultrawork) outlive the skill-active window — ralph's Stop-block behavior
must persist across many turns after the skill completes, which skill-frontmatter hooks
cannot support. Additionally, hooks declared in skill frontmatter are invisible to
`scripts/validate-plugin.sh`, which validates hooks only from `hooks/hooks.json`. All
OMCA hook registration stays in `hooks/hooks.json`.

**`skillOverrides`, `skillListingBudgetFraction`, `maxSkillDescriptionChars` settings (v2.1.141–v2.1.167, not adopted):**

These are user-preference settings in `settings.json`:
- `skillOverrides` — per-skill invocation-mode overrides (e.g., `"user-invocable-only"`). Does **not** apply to plugin-shipped skills; only affects user-scope and project-scope skills.
- `skillListingBudgetFraction` — fraction of context budget allocated to skill listing.
- `maxSkillDescriptionChars` — cap on characters shown per skill description in listings.

OMCA does not adopt any of them. The plugin controls its own skill descriptions and invocation contracts; user-side `skillOverrides` has no effect on plugin skills and cannot be used to restrict or redirect them.

**`\$` escape syntax (v2.1.163):**

In SKILL.md bodies, `\$` is now a documented escape for a literal dollar sign (prevents
variable interpolation by the platform). OMCA has zero literal dollar-digit sequences in
command/skill bodies; no existing files need updating.

**`/reload-skills` command (v2.1.152):**

The platform adds a `/reload-skills` command that reloads skill definitions from disk
without restarting the session. Useful after editing a SKILL.md mid-session. OMCA has no
handler for this — it fires as a slash-command expansion, not a hook event.

**Platform `workflow` keyword renamed `ultracode` (v2.1.157):**

The platform's built-in dynamic-workflow keyword was renamed from `workflow` to
`ultracode` in v2.1.157. This is unrelated to OMCA's own `ultrawork` keyword and the
`/oh-my-claudeagent:ultrawork` skill. OMCA does not reference the platform keyword;
no OMCA files are affected.

### Hooks

Hooks are bash scripts in `scripts/*.sh`, registered in `hooks/hooks.json`. They run on
Claude Code lifecycle events and provide:

- Context injection (AGENTS.md, rules, notepad directives)
- Persistence blocking (ralph mode prevents Stop events)
- Permission auto-approval for known-safe package managers (npm, yarn, pnpm, bun), jq, and uv run/sync. Blocks destructive patterns (rm -rf).
- Error recovery suggestions (re-read after failed Edit, escalate after failed Agent)
- Compaction survival (state saved pre-compact, re-injected post-compact)
- Verification gating (TaskCompleted blocked without fresh evidence)

**Hook events OMCA handles:**

| Event | Category |
|-------|----------|
| `SessionStart` | Lifecycle |
| `UserPromptSubmit` | Lifecycle |
| `UserPromptExpansion` | Lifecycle |
| `SubagentStart` | Lifecycle |
| `SubagentStop` | Lifecycle |
| `PreToolUse` | Tool lifecycle |
| `PermissionRequest` | Tool lifecycle |
| `PostToolUse` | Tool lifecycle |
| `PostToolUseFailure` | Tool lifecycle |
| `Stop` | Lifecycle |
| `StopFailure` | Lifecycle |
| `TaskCreated` | Task lifecycle |
| `TaskCompleted` | Task lifecycle |
| `TeammateIdle` | Collaboration |
| `PreCompact` | Memory |
| `PostCompact` | Memory |
| `SessionEnd` | Lifecycle |
| `Notification` | Observability |
| `ConfigChange` | Observability |
| `CwdChanged` | Observability |
| `FileChanged` | Observability |
| `WorktreeCreate` | Worktree |
| `WorktreeRemove` | Worktree |
| `InstructionsLoaded` | Observability |

**New platform events (v2.1.141–v2.1.167):**

| Event | Added | Status | Notes |
|-------|-------|--------|-------|
| `MessageDisplay` | v2.1.152 | Not adopted | Fires when a message is about to be displayed |
| `PostToolBatch` | v2.1.152 | **Adopted (v2.7.0)** | Fires after a batch of tool calls completes — see handler details below |
| `Elicitation` | v2.1.152 | Not adopted | Fires when the model issues an elicitation request |
| `ElicitationResult` | v2.1.152 | Not adopted | Fires with the elicitation response |
| `Setup` | v2.1.152 | Not adopted | Plugin initialization event |

The four non-adopted events are tracked in `validate-plugin.sh`'s `new_platform_events` array
(introduced v2.1.141–v2.1.167 sync). The validator skips them when no handler is present and
passes when one is present — no failures on absence. `PostToolBatch` has been moved to the
registered-events array as of v2.7.0.

**PostToolBatch handler v1 (v2.7.0):**

Registered matcher-less (the event supports no matchers) in `hooks.json` → `scripts/post-tool-batch.sh`.
Non-blocking: both signals emit `additionalContext` only; no `decision:block`.

The batch payload carries a `tool_calls[]` array (empirically captured — not documented
in platform docs) with fields `tool_name`, `tool_input`, `tool_use_id`, and `tool_response`
per entry.

Two signals implemented:

- **Same-file parallel-edit warning** (all sessions): when ≥2 entries in a batch target
  the same `file_path` with Write, Edit, or NotebookEdit, emits a warning identifying the
  conflicting path.
- **Batch-consolidated delegation reminder** (main session only — skips subagent batches):
  increments `toolCallCount` in `agent-usage.json` once per batch containing ≥1 of
  Grep / Glob / WebFetch / WebSearch entries; emits the existing delegation reminder at
  every 3rd increment when `agentUsed` is still `false`. Batches with no qualifying tools
  are skipped. Batches from subagent sessions (agent_id present in payload) are skipped.

**agent-usage-reminder.sh migration (v2.7.0):**

`scripts/agent-usage-reminder.sh` (the prior per-call PostToolUse handler for Grep / Glob /
WebFetch / WebSearch) has been removed. The delegation-reminder counting has moved from
per-call (one increment per qualifying tool call) to per-batch (one increment per batch that
contains ≥1 qualifying call). `agent-usage.json` schema is unchanged — `agentUsed` (boolean)
and `toolCallCount` (integer) fields remain the same. The `agentUsed=true` suppression
path is preserved: once any Agent call fires, the reminder is silenced for the rest of
the session regardless of batch content.

**Stop / SubagentStop — new input fields (v2.1.145):**

The Stop and SubagentStop hook payloads now include two additional fields:

| Field | Type | Notes |
|-------|------|-------|
| `background_tasks` | array | Platform-managed background tasks running at Stop time |
| `session_crons` | array | Scheduled cron jobs registered for the session |

OMCA's ralph-persistence.sh does not consult these fields — the block/allow decision is
based solely on ralph state and boulder progress. Background tasks are orthogonal to ralph
blocking. (Verified by test: the v2.1.145 Stop payload change has zero
behavioral impact on OMCA hooks.)

**Stop / SubagentStop — `additionalContext` output (v2.1.163):**

Hooks can now return `hookSpecificOutput.additionalContext` from Stop / SubagentStop.
OMCA deliberately does not adopt this: co-existence with `decision:block` is not
documented (schema inconclusive); exit-2 paths ignore all JSON output entirely, so any
`additionalContext` set alongside a block decision would be silently dropped. OMCA's
existing block shape `{"decision": {"behavior": "block"}, "reason": "..."}` is unchanged.
(See "Deliberate non-adoptions" section below for the non-adoption log.)

**SessionStart — new output fields (v2.1.152):**

`SessionStart` hooks can return two new fields:

| Field | Adopted by OMCA | Notes |
|-------|----------------|-------|
| `sessionTitle` | Yes — `session-init.sh` emits `"OMCA: <plan_name>"` when boulder is active | Sets the session title in the platform UI |
| `reloadSkills` | No | Boolean; forces a skill reload on session start — no OMCA use case |

**Stop hook block cap (v2.1.143):**

The platform enforces a maximum of 8 consecutive Stop blocks per session. The cap is
configurable via `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (env var). OMCA's
`ralph-persistence.sh` reads this env var (`STOP_BLOCK_CAP="${CLAUDE_CODE_STOP_HOOK_BLOCK_CAP:-8}"`)
and emits a voluntary allow-stop (exit 0, no `decision:block`) at `cap-1` consecutive
no-progress blocks, with reason `"Yielding to platform. To resume: invoke /oh-my-claudeagent:ralph again."`.
Cap state is tracked in `.omca/state/ralph-cap-state.json`. (Adopted in the v2.1.141–v2.1.167 sync.)

**`SessionStart` `watchPaths` output (v2.1.141–v2.1.167, not adopted):**

`SessionStart` hooks can return a `watchPaths` array to register file-system paths for
`FileChanged` event delivery. OMCA does not adopt this because the `FileChanged` handler
(`scripts/cwdchanged.sh`, aliased) is side-effects-only — it logs the event and notifies;
there is no runtime reader that would benefit from expanded watch coverage. Extending the
watch set would generate noise without actionable signal.

**`PostToolUse` `updatedToolOutput` field (v2.1.141–v2.1.167, not adopted):**

`PostToolUse` hooks can return `updatedToolOutput` to rewrite the tool result visible to
the model. OMCA deliberately does not adopt this. Rewriting tool output post-hoc is
adversarial to evidence integrity — OMCA's verification model depends on the model seeing
the literal command output, not a hook-filtered version. All context augmentation is done
via `additionalContext`, which appends without overwriting.

**Hooks run without terminal access (v2.1.141+):**

Hook scripts no longer have access to `/dev/tty` or terminal control sequences.
OMCA's `scripts/notify.sh` is unaffected — it uses only desktop notification APIs
(`terminal-notifier`, `osascript`, `notify-send`, `zenity`, `powershell`) and stderr bell,
with zero `/dev/tty` or `tput` calls.

Hooks can now emit a `terminalSequence` output field to inject terminal escape sequences:
```json
{"hookSpecificOutput": {"hookEventName": "EVENT", "terminalSequence": "[2J"}}
```
OMCA does not use `terminalSequence` — existing desktop-notification paths remain unchanged.

**`if:` condition matching semantics (v2.1.163):**

The `if:` field on hook handlers updated its matching semantics in v2.1.163. OMCA's
12 `if:` clauses are all command-name-only globs (e.g., `Bash(rm *)`, `Bash(npm *)`) and
are unaffected — the update only changes behavior for patterns that use subshell or
backtick constructs, which OMCA does not.

Hook handlers support an `if` field using permission rule syntax (e.g., `Bash(git *)`)
for argument-level filtering on tool events (`PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `PermissionRequest`). Reduces process spawning overhead.

Hooks communicate via stdout JSON:
```json
{"hookSpecificOutput": {"hookEventName": "EVENT", "additionalContext": "..."}}
{"hookSpecificOutput": {"hookEventName": "Stop", "decision": {"behavior": "block"}}}
```

### bin/

Added in v2.1.91 (changelog.md:895). Plugins can ship executable scripts or binaries under a `bin/` directory at the plugin root. Claude Code prepends that directory to the Bash tool's `PATH` for the duration of the session, so any executable placed there is available as a bare command without specifying a full path. Files must have the executable bit set (`chmod +x`) and a `#!/usr/bin/env bash` (or equivalent) shebang.

OMCA ships:
- `bin/omca-status` — print active boulder, evidence summary, F1-F4 status, and currently-running subagents
- `bin/omca-doctor` — read-only health check (dependencies, settings, state directories, MCP server)

Both scripts are invokable from any Bash tool call as bare commands: `omca-status` and `omca-doctor`. They read the project's `.omca/state/` and `~/.claude/settings.json` only, and never mutate state.

Plugin-root `settings.json` ships a `subagentStatusLine` default backed by `bin/omca-subagent-statusline`. Users can override per-project by setting their own `subagentStatusLine` in `~/.claude/settings.json` or a project-level settings file. Omitting all overrides falls back to the platform's default `name · description · token count` row.

**`statusLine.refreshInterval` (v2.7.0, ADOPTED):**

`omca-setup` Phase 5.6 sets `statusLine.refreshInterval: 5` (seconds) in `~/.claude/settings.json` alongside `hideVimModeIndicator`. This is the recommended value for OMCA: the statusline reads disk-cached git metadata (branch, PR state) that updates on roughly a 5 s cadence, so a matching refresh interval keeps the display current without polling faster than the cache. In background-agent idle scenarios — where the model is waiting on a subagent and no tool calls are firing — the platform only refreshes the statusline at this interval, so a value below 5 yields no additional freshness from the disk-cached sources. Doc-claim ceiling: the freshness improvement is specific to disk-sourced fields (`workspace.repo.*`, `pr.*`); fields sourced directly from the active tool call context update on each render regardless of this setting.

**Statusline platform additions (v2.1.141–v2.1.167):**

New fields added to the statusline input JSON payload, adopted in `statusline/core.py`:

| Field | Version | Adopted | Notes |
|-------|---------|---------|-------|
| `workspace.repo.{host,owner,name}` | v2.1.145 | Yes | Repo identity segment; OSC 8 link to `https://{host}/{owner}/{name}` when all three present |
| `pr.{number,url,review_state}` | v2.1.145 | Yes | PR number (#N) with optional OSC 8 link; review_state → glyph (approved=+/green, changes_requested=!/red, pending=?/yellow, draft=d/dim) |
| `COLUMNS` / `LINES` env vars | v2.1.153 | Yes — `COLUMNS` fallback in `bin/omca-subagent-statusline` | Payload `columns` still wins; env vars complement when payload absent |
| `context_window.remaining_percentage` | v2.1.153 | Yes — `_render_context_bar` uses it when `pct` arg is None | Falls back to `current_usage` calculation; explicit `pct` still wins |

### plugin.json

OMCA's `plugin.json` is the plugin manifest. Key fields and recent platform additions:

**`displayName` (v2.1.143, ADOPTED):**

A human-readable display name shown in the plugin marketplace and `/plugin list` output.
OMCA sets `displayName` in `plugin.json`. Added during v2.1.141–v2.1.167 sync.

**`defaultEnabled` (v2.1.154, NOT adopted):**

Setting `"defaultEnabled": false` keeps a plugin installed but inactive until explicitly
enabled. OMCA deliberately leaves this field absent (defaults to `true`) — OMCA is
designed to be active immediately on install; an inactive-by-default state would break
the first-session experience.

**Root-level `SKILL.md` for single-skill plugins (v2.1.142):**

Plugins that ship exactly one skill can place `SKILL.md` at the plugin root (instead of
`skills/<name>/SKILL.md`). OMCA ships many skills and continues using the subdirectory
layout; the root-level shorthand is not applicable.

**Dependency enforcement on disable (v2.1.143):**

When a plugin is disabled, Claude Code now checks whether other enabled plugins declare
it as a dependency and blocks the disable if so. OMCA has no declared dependents in
OMCA's known marketplace installations; this mechanism does not affect OMCA's install or
disable behavior.

### Monitors

Added in v2.1.105 (changelog.md:640). Since v2.1.129 they must live under `"experimental": {}` in `plugin.json` or `claude plugin validate` will warn. Monitors are background processes defined in `monitors/monitors.json` that Claude Code starts automatically when the plugin is active. Each monitor entry specifies a `name`, a long-running `command` (e.g. `tail -F ./logs/error.log`), and an optional `description`; each stdout line is delivered to Claude as a notification during the session.

OMCA does not currently adopt monitors — the hook-based context injection model covers all current context-delivery needs. The mechanism is documented here for future evaluation if real-time file-watch or external-event delivery is needed.

```json
// monitors/monitors.json (example — not currently used by OMCA)
[
  {
    "name": "error-log",
    "command": "tail -F ./logs/error.log",
    "description": "Application error log"
  }
]
```

---

## Getting Started

### Installation

From the command line:

```bash
claude plugin marketplace add UtsavBalar1231/oh-my-claudeagent
claude plugin install oh-my-claudeagent@omca
```

Or from inside a Claude Code session:

```
/plugin marketplace add UtsavBalar1231/oh-my-claudeagent
/plugin install oh-my-claudeagent@omca
```

### Setup

After installing, run `/oh-my-claudeagent:omca-setup`. This checks dependencies (`jq`,
`uv`, `python3` 3.10+), injects the orchestration block into `~/.claude/CLAUDE.md`,
offers to apply permission rules, and prints a health report. Use `--check` for read-only
health check, `--uninstall` to remove.

### Plugin lifecycle commands

| Command | Use case |
|---|---|
| `claude plugin install <name>` | Install a plugin from a known marketplace |
| `claude plugin details <name>` | (v2.1.139+) Show a plugin's component inventory and projected per-session token cost — useful before installing or for diffing cost across versions |
| `claude plugin list` | List installed plugins; surfaces folder-shadow warnings introduced in v2.1.140 |
| `claude plugin tag <plugin> <tag>` | Tag an installed plugin version |
| `claude plugin prune` | Remove unused cached plugin versions |
| `claude project purge` | Remove cached plugin state for the current project |
| `claude --prune` | Cascade prune: plugins + transitive dependencies |

Run `claude plugin details oh-my-claudeagent` before a major release to capture the pre-bump token-cost projection; compare against the post-bump value to spot accidental cost regressions.

### Team Setup

Add to `.claude/settings.json` for automatic team-wide installation:

```json
{
  "extraKnownMarketplaces": {
    "omca": {"source": {"source": "github", "repo": "UtsavBalar1231/oh-my-claudeagent"}}
  },
  "enabledPlugins": {"oh-my-claudeagent@omca": true}
}
```

### First Session Walkthrough

1. Install and run omca-setup
2. Start a new session: `claude`
3. Try the planning pipeline: type "create plan for adding user authentication"
   — Prometheus opens an interview, gathers requirements, generates a work plan
4. After plan review: run `/oh-my-claudeagent:start-work`
   — Sisyphus picks up the plan and delegates tasks to executor in parallel
5. For guaranteed completion: type "ralph don't stop"
   — Ralph mode activates; the session blocks on Stop until all tasks are verified
6. For maximum speed: type "ultrawork"
   — Ultrawork batches independent tasks across up to 5 concurrent agents
7. When context is long: type "handoff"
   — A structured session summary is produced for pasting into a new session

---

## Agent Reference

### Orchestrator

| Agent | Model | Effort | Invoke | Purpose |
|-------|-------|--------|--------|---------|
| sisyphus | claude-fable-5[1m] | high | Main session (injected via `templates/claudemd.md`) or `/oh-my-claudeagent:start-work` (Plan Execution Mode) | Master orchestrator identity — classifies requests, delegates to specialists. Two modes: free-form (conversational) and plan-driven (via `/start-work` command body). Plan Execution Mode protocol lives in `commands/start-work.md`. |

**sisyphus** — The one orchestrator. Free-form mode: routes requests to specialists, runs explore agents in background. Plan Execution Mode: reads plan, delegates per-task to `executor`, runs Final Verification Wave (F1 via oracle, F2-F4 via executor), waits for sign-off.

### Planning and Review

| Agent | Model | Effort | Invoke | Purpose |
|-------|-------|--------|--------|---------|
| prometheus | claude-fable-5[1m] | high | `/oh-my-claudeagent:plan` or "create plan" | Strategic planning with requirements interview + optional Socratic Interview Mode |
| metis | claude-fable-5[1m] | high | `/oh-my-claudeagent:metis` or "run metis" | Pre-planning gap analysis |
| momus | claude-fable-5[1m] | high | `Skill(oh-my-claudeagent:momus)` (or `Agent(subagent_type="oh-my-claudeagent:momus")` from the main session) | Rigorous plan review — OKAY or REJECT |
| oracle | claude-fable-5[1m] | max | `Agent(subagent_type="oh-my-claudeagent:oracle")` | Architecture advisor, read-only |

**prometheus** — 9-item clearance checklist interview, consults metis, generates plan,
submits to momus for review (up to 3 iterations). Optional Socratic Interview Mode for
ambiguous or architectural requests: iterative dialogue, synthesis stop-criterion, does NOT
write to `~/.claude/plans/` (research output only).

**metis** — Classifies intent, explores codebase, identifies hidden requirements and scope
risks. Invoked automatically by prometheus.

**momus** — Evaluates plans against 5 criteria. Approval-biased for normal,
reversible plans, strict for high-risk or irreversible work.

**oracle** — Read-only. Dense output: bottom line in 2-3 sentences, action plan in 7
steps max, effort estimates (Quick/Short/Medium/Large).

### Search and Research

| Agent | Model | Effort | Invoke | Purpose |
|-------|-------|--------|--------|---------|
| explore | sonnet | medium | `Agent(..., run_in_background=true)` | Codebase search — files, patterns, implementations |
| librarian | sonnet | medium | `Agent(..., run_in_background=true)` | External docs, OSS examples, library research |

**explore** — Always run in background. Uses ast_search, Grep, Glob. Fire multiple in
parallel for broad searches.

**librarian** — Uses context7 for library docs, and may create shallow read-only
dependency clones under `/tmp/opencode` for source investigation.

Socratic research interview is now part of `prometheus` (Socratic Interview Mode section).

### Execution

| Agent | Model | Effort | Invoke | Purpose |
|-------|-------|--------|--------|---------|
| executor | sonnet | medium | `Agent(subagent_type="oh-my-claudeagent:executor")` | Focused task executor — implements directly, never delegates implementation |
| hephaestus | sonnet | medium | `/oh-my-claudeagent:hephaestus` or "fix build" | Build and toolchain fixer — minimal-diff policy |
| multimodal-looker | sonnet | medium | `Agent(subagent_type="oh-my-claudeagent:multimodal-looker")` | Image, PDF, diagram analysis (read-only) |

**executor** — Implements one atomic task per delegation. Escalates to explore/librarian
via recommendations in output text (cannot spawn subagents at depth 1). Requires fresh
verification evidence before claiming completion.

**hephaestus** — Reproduce, diagnose, fix, verify. Repeat until exit code 0. Never
refactors while fixing. Stops and escalates after 5+ failed attempts.

---

## Skill Reference

### Persistence

| Skill | Slash command | Keywords |
|-------|--------------|----------|
| ralph | `/oh-my-claudeagent:ralph` | "ralph", "don't stop", "must complete", "until done", "keep going until", "finish this no matter" |
| ultrawork | `/oh-my-claudeagent:ultrawork` | "ulw", "ultrawork" |
| ulw-loop | `/oh-my-claudeagent:ulw-loop` | "ulw-loop", "ultrawork loop" |

**ralph** — Persistence loop. Blocks the Stop event until all tasks are verified by oracle.
State stored in `.omca/state/ralph-state.json`.

**ultrawork** — Maximum parallel execution. Batches independent tasks across up to 5
concurrent agents.

**ulw-loop** — Combines ralph persistence with ultrawork parallelism AND oracle verification.
Strictest completion guarantee.

### Planning Pipeline

| Entrypoint | Surface | Invocation | Keywords |
|------------|---------|------------|----------|
| plan | command | `/oh-my-claudeagent:plan` | "create plan" |
| metis | skill | `/oh-my-claudeagent:metis` | "run metis" |
| start-work | command | `/oh-my-claudeagent:start-work` | (none) |

**start-work** — Finds the active plan (via boulder state, `.omca/plans/`, or
`~/.claude/plans/`), sets up boulder state, optionally configures a git worktree,
then enters Plan Execution Mode in the main session (sisyphus identity) at depth 0.
The Plan Execution Mode protocol body lives in `commands/start-work.md`.

### Fixing and Development

| Skill | Slash command | Keywords |
|-------|--------------|----------|
| hephaestus | `/oh-my-claudeagent:hephaestus` | "fix build", "build broken" |
| refactor | `/oh-my-claudeagent:refactor` | (none) |
| git-master | `/oh-my-claudeagent:git-master` | (none — invoked via `/git-master` or when Claude matches the task to the skill description) |

**refactor** — Codebase-aware refactoring: parallel analysis via 5 explore agents, codemap
and impact zone mapping, test coverage check, prometheus plan, step-by-step execution with
ast-grep, final verification wave.

**git-master** — Atomic commits with style detection, rebase/squash, history search (blame,
bisect, log -S).

### Browser

| Skill | Slash command | Keywords |
|-------|--------------|----------|
| playwright | `/oh-my-claudeagent:playwright` | (none) |
| dev-browser | `/oh-my-claudeagent:dev-browser` | "go to [url]", "take a screenshot" |

### Session Management

| Skill | Slash command | Keywords |
|-------|--------------|----------|
| handoff | `/oh-my-claudeagent:handoff` | "handoff", "context is getting long", "start fresh session" |
| cancel-ralph | `/oh-my-claudeagent:cancel-ralph` | (slash-command only) |
| stop-continuation | `/oh-my-claudeagent:stop-continuation` | "stop continuation", "pause automation", "take manual control" |

**handoff** — Gathers context from git, tasks, boulder state, and notepads, then produces
a structured HANDOFF CONTEXT block for pasting into a new session.

### Setup and Discovery

| Skill | Slash command | Keywords |
|-------|--------------|----------|
| omca-setup | `/oh-my-claudeagent:omca-setup` | "setup omca" |
| init-deep | `/oh-my-claudeagent:init-deep` | (none) |
| frontend-ui-ux | `/oh-my-claudeagent:frontend-ui-ux` | (none) |
| github-triage | `/oh-my-claudeagent:github-triage` | (slash-command only) |
| consolidate-memory | `/oh-my-claudeagent:consolidate-memory` | (none) |

**github-triage** — Fetches open issues and PRs, classifies each, spawns one background
agent per item in parallel. Zero-action policy: never merges, closes, or edits items.

---

## Common Workflows

### Planning Pipeline

```
1. Type "create plan for [your task]"
   -> Prometheus interviews, consults metis, generates plan, runs momus review
   -> After momus approval, prometheus asks: start implementation or run metis review?

2. Run /oh-my-claudeagent:start-work (or prometheus starts it after user confirms)
   -> Finds active plan, sets up boulder state, enters Plan Execution Mode at depth 0

3. Main session (sisyphus identity) executes the Plan Execution Mode protocol:
   -> Delegates each task to executor
   -> Verifies with build/typecheck/tests after each
   -> Marks checkboxes in plan file
   -> Final Verification Wave (F1 oracle + F2-F4 executor)

4. Resume after interruption with /oh-my-claudeagent:start-work
   -> Boulder state resumes from last completed task
```

### Ralph Persistence

Ralph mode prevents the session from ending until work is verified complete.

```
1. Type "ralph don't stop" or "ralph: [task description]"
   -> ralph-persistence.sh (Stop hook) blocks Stop events
   -> Session continues until oracle approves

2. On error: creates fix task, continues (never stops on error)
   On 3 consecutive failures: escalates to oracle
   After all tasks: oracle verification required

3. Cancel: type "cancel ralph"
```

### Ultrawork Parallel Execution

```
1. Type "ultrawork" or "ulw [task]"
2. Tasks analyzed for parallelizability
3. Independent tasks batched — up to 5 Agent() calls per batch
4. Failures become fix tasks, execution continues
5. Final verification with evidence_log
```

### Session Handoff

When context is long and quality is degrading:

```
1. Type "handoff"
2. Copy the HANDOFF CONTEXT output
3. Start new session, paste context as first message
4. Continue: "Continue from the handoff context above. [Next task]"
```

---

## MCP Tools

Three MCP servers are bundled via `.mcp.json` and launched by Claude Code.

### omca (local Python FastMCP server)

Unified server for structural code search, plan tracking, verification, notepads, and filesystem access.

**AST tools** — Structural code search using ast-grep:

| Tool | Purpose |
|------|---------|
| `ast_search` | Find code patterns by structure (function signatures, class shapes) |
| `ast_replace` | Structural find-and-replace (`dry_run=true` to preview) |
| `ast_find_rule` | Advanced structural queries with YAML combinators |
| `ast_test_rule` | Test a rule pattern against a code snippet |
| `ast_dump_tree` | Dump AST of a code snippet for rule development |

**Boulder tools** — Plan tracking across sessions:

| Tool | Purpose |
|------|---------|
| `boulder_write` | Register/select an active work plan in schema v2 multi-work state |
| `boulder_progress` | Check completed vs remaining tasks for active or selected work |
| `boulder_list` | List resumeable works, counts, and progress summaries |
| `boulder_select` | Select one existing work as active |
| `boulder_complete` | Mark one work completed while retaining other works |
| `boulder_task_start` / `boulder_task_end` | Track per-task session and timing metadata |
| `mode_read` | Read active modes (ralph, ultrawork, boulder, evidence) |
| `mode_clear` | Deactivate modes (default: all) |

**Evidence tools** — Verification records:

| Tool | Purpose |
|------|---------|
| `evidence_log` | Record verification result: `evidence_log(evidence_type, command, exit_code, output_snippet)` |
| `evidence_read` | Read accumulated evidence |

**Notepad tools** — Per-plan knowledge accumulation:

| Tool | Purpose |
|------|---------|
| `notepad_write` | Append to a section: `notepad_write(plan_name, section, content)` |
| `notepad_read` | Read a section |
| `notepad_list` | List available plans and sections |

Sections: `learnings`, `issues`, `decisions`, `problems`.

**Filesystem tools** — External file access for subagents:

| Tool | Purpose |
|------|---------|
| `file_read` | Read any file with line numbers — bypasses sandbox scoping |

### grep (HTTP, via grep.app)

Public GitHub code search across approximately 1 million repositories. Use for finding
real-world usage examples, API patterns, and library implementations.

### context7 (HTTP, via context7.com)

Library documentation lookup. Two-step flow: resolve library ID first, then query docs.
Prefer context7 over WebFetch for well-known libraries.

### MCP platform additions (v2.1.141–v2.1.167)

**stdio servers receive session env vars (v2.1.154, ADOPTED):**

stdio MCP servers now receive `CLAUDE_CODE_SESSION_ID` and `CLAUDECODE=1` in their
environment at launch. The `omca` server's `_resolve_session_id()` helper in
`servers/tools/_common.py` uses `os.environ.get("CLAUDE_CODE_SESSION_ID", "")` as a
fallback when no explicit `session_id` parameter is passed. Adopted in `boulder_write`
and `boulder_task_start` (v2.1.141–v2.1.167 sync).

**`dependencies` in `plugin.json` (v2.1.141–v2.1.167, not adopted):**

Plugins can declare a `dependencies` array in `plugin.json` to express inter-plugin
dependencies. Declaring a dependency causes Claude Code to block disabling a dependency
plugin while this plugin is active. OMCA has no runtime dependencies on other plugins
and does not adopt this field. No OMCA consumers exist for this schema path.

Note on marketplace tag convention: the platform marketplace uses `{plugin-name}--v{version}`
(double-dash) tag format for versioned releases (e.g., `oh-my-claudeagent--v2.6.0`),
while OMCA's own version tags follow `vX.Y.Z` (single prefix, no plugin-name prefix).
The `claude plugin install oh-my-claudeagent@omca` install path resolves via the
`omca` marketplace shortname, not a version tag, so the tag-format difference has no
practical impact on installs or upgrades.

**MCP `headersHelper` and WebSocket (`ws`) transport (v2.1.141–v2.1.167, not adopted):**

Two MCP transport additions were introduced in this window:
- `headersHelper` — a helper for injecting dynamic auth headers into HTTP-based MCP servers.
- WebSocket (`ws`) transport — an alternative connection mode alongside stdio and SSE.

OMCA's three bundled servers all use stdio transport (`type: "stdio"` in `.mcp.json`) and
require no auth headers. Neither feature has any OMCA consumers; no adoption is needed.

**Per-server `timeout` < 1000 ms is now ignored (v2.1.162):**

Previously, a per-server timeout below 1000 ms was floored to 1000 ms. As of v2.1.162
it is silently ignored (no floor applied, no error). OMCA's `.mcp.json` has no `timeout`
keys — this change has no behavioral impact.

**Unapproved `.mcp.json` servers show "Pending approval" (v2.1.154):**

Servers listed in `.mcp.json` but not yet approved by the user now display a
"Pending approval" status indicator rather than silently failing. OMCA's three bundled
servers (`omca`, `grep`, `context7`) are approved on first install; users seeing
"Pending approval" should run `/oh-my-claudeagent:omca-setup --check` to diagnose.

---

## Runtime State

All runtime state lives in `.omca/` (gitignored by default):

- `state/boulder.json` — Schema v2 multi-work plan state (top-level fields mirror the selected active work; `works` preserves other active/completed work)
- `state/verification-evidence.json` — Verification records
- `state/ralph-state.json` — Ralph persistence state
- `state/compaction-context.md` — Saved state for compaction survival
- `state/notepads/{plan-name}/` — Per-plan notepad sections
- `plans/{name}.md` — Compatibility mirror/resume surface for native plans, maintained by boulder
- `logs/` — Session, edit, and subagent audit logs
- `rules/*.md` — Project rules (auto-injected on file match)

### Boulder Lifecycle

1. Prometheus creates a plan at `~/.claude/plans/{name}.md` or the active plan-mode file
2. `boulder_write(active_plan, plan_name, session_id)` registers or selects a work, appends the session, and may mirror the plan under `.omca/plans/` for compatibility
3. `/start-work` reads `boulder_list()`/`mode_read()` and resumes the selected work; multiple resumeable works are selectable via `boulder_select`
4. Sisyphus/start-work uses `boulder_progress`, `boulder_task_start`, and `boulder_task_end` to track execution
5. F4 approval marks the current work complete; boulder state is retained while other resumeable works remain
6. `/stop-continuation` or `mode_clear` clears persistence state when explicitly requested

### Evidence Workflow

After every build, test, or lint command:
```
evidence_log(evidence_type="build", command="just ci", exit_code=0, output_snippet="all checks passed")
```

The `task-completed-verify` hook blocks task completion (exit 2) if evidence is stale
(> 5 minutes) and the task text implies verification was needed. Evidence gating is
keyword-aware — tasks without verification keywords (test, build, lint, verify) skip
strict evidence requirements.

### Project Rules

Create `.omca/rules/name.md` with a `# pattern: <glob>` header. When any file matching
the glob is Read, Written, or Edited, the rule content is injected as additional context.

---

## Keyword Activation

Mode detection is dual-path:

- **Free-text triggers** — `keyword-detector.sh` fires on `UserPromptSubmit`, pattern-matches the raw prompt text (e.g., "ralph don't stop"), and injects context.
- **Slash-command triggers** — `slash-command-mode-detector.sh` fires on `UserPromptExpansion`, reads `command_name` directly (e.g., `oh-my-claudeagent:ralph`), and activates the corresponding mode without relying on the expanded body's wording. This is more reliable: mode activation works regardless of what the skill's SKILL.md body says.

Both paths share the same `active-modes.json` schema and session-aware re-announce suppression (`mode_already_announced` / `mark_mode_announced` in `scripts/lib/common.sh`). If both fire for the same mode in the same session, the second invocation suppresses silently.

The `keyword-detector.sh` hook fires on `UserPromptSubmit`, pattern-matches against
known phrases, and injects context that triggers the corresponding skill.

Keywords are the natural interaction model — type natural phrases in any prompt.

### Full Keyword Map

| Keyword / Phrase | Activates |
|------------------|-----------|
| `ralph`, `don't stop`, `must complete`, `until done`, `keep going until`, `finish this no matter` | ralph mode — persistence loop |
| `ulw`, `ultrawork`, `run in parallel`, `simultaneously`, `as fast as possible` | ultrawork — parallel execution |
| `handoff`, `context is getting long`, `start fresh session` | session handoff |
| `stop continuation`, `pause automation`, `take manual control` | stop-continuation skill |
| `run metis`, `metis analyze`, `pre-plan` | metis skill |
| `run prometheus`, `create plan` | `/oh-my-claudeagent:plan` command (prometheus planning) |
| `fix build`, `build broken` | hephaestus skill |
| `setup omca` | omca-setup skill |

### @-Mention Syntax

Type `@agent-oh-my-claudeagent:<name>` to guarantee delegation to a specific agent:

```
@agent-oh-my-claudeagent:oracle what's the right architecture here?
@agent-oh-my-claudeagent:explore find all usages of the auth middleware
```

---

## Session Persistence

### Ralph Stop-Blocking

`ralph-persistence.sh` runs on the Stop event. If ralph mode is active, it returns
`{"decision": {"behavior": "block"}}` to prevent the session from ending. The session
continues until oracle approves and ralph writes its completed state.

### Compaction Survival

When the context window fills, the plugin preserves state across compaction via a
three-script pipeline: `pre-compact.sh` (PreCompact) saves state, `post-compact-log.sh`
(PostCompact) logs it, and `post-compact-inject.sh` fires on `SessionStart` with reason
`compact` — not on PostCompact. Ralph mode, active plans, and task state survive compaction.

### StopFailure Limitation

`StopFailure` fires on API errors and is logging-only — hooks cannot block it. If an API
error occurs during ralph, manually resume with `/oh-my-claudeagent:start-work`.

---

## Troubleshooting

**MCP tools not available:** Check `ast-grep`/`sg` and `uv` are installed. Run
`/oh-my-claudeagent:omca-setup --check`. Run `/reload-plugins` to restart MCP servers.

**Subagent nesting depth:** `/oh-my-claudeagent:start-work` runs inline in the main
session at depth 0 with full `Agent`-tool access. Parallel fan-out, specialist delegation,
and independent F1-F4 review via `oracle` (F1) / `executor` (F2-F4) all work. The command
body in `commands/start-work.md` is the authoritative Plan Execution Mode protocol. There
is no degraded mode — orchestration only runs at depth 0 by design. The `atlas` agent was
removed in v2.0; its plan-execution protocol migrated to the command body, its orchestrator
role consolidated into `sisyphus` (the main-session identity).

**Hook changes not taking effect:** Run `/reload-plugins`.

**AskUserQuestion unavailable in subagents:** Subagents emit a `## BLOCKING QUESTIONS`
block at the end of their final response (Q1., Q2., lettered options A/B/C, Recommended:
line). The orchestrator hydrates `AskUserQuestion` via `ToolSearch`, relays, and resumes
the subagent via `SendMessage`. The platform caps each `AskUserQuestion` call at 4
questions; when a subagent raises more, the orchestrator makes multiple sequential calls
within the same turn to relay all of them.

**permissionMode stripping:** Claude Code strips `permissionMode` from plugin agents.
Copy agent files to `~/.claude/agents/` (user-scope agents retain it).

**Native mode-indicator row duplicates OMCA's vim glyph:** the platform draws a
`-- INSERT --` row beneath the user's `statusLine` output. The OMCA statusline
already renders `vim.mode` on line 1, so the row is duplicate noise. Set
`statusLine.hideVimModeIndicator: true` to suppress the platform row
(documented in `https://code.claude.com/docs/en/statusline`); `omca-setup` Phase 5.6
sets this automatically on first run and back-fills it on re-run for users with
an existing `statusLine` config. Phase 5.6 also sets `statusLine.refreshInterval: 5`
alongside `hideVimModeIndicator` — see the `statusLine.refreshInterval` entry in the
`bin/` section above for the cache-TTL rationale. (Earlier versions of this document
did not mention `refreshInterval`; it was added in the 2026-06 feature sweep.)

**Permission-mode banner — no opt-out:** the `›› bypass permissions on (shift+tab
to cycle)` indicator on the same native mode-indicator row has no documented
suppression setting as of Claude Code v2.1.141. The platform renders it whenever
the active permission mode is non-`default`. The only ways to hide it are: (a)
switch the active permission mode back to `default` via `/permission-mode`, or
(b) wait for Anthropic to add a `hidePermissionModeIndicator` companion to the
documented `hideVimModeIndicator` field. File feedback citing the vim-indicator
precedent if this matters to your workflow.

---

## Environment Variables

Key environment variables available to hooks, skills, and Bash tool commands.

### `CLAUDE_CODE_SESSION_ID` (v2.1.132)

The current session ID is injected into the Bash tool subprocess environment, matching the `session_id` value passed to hook scripts. Hook scripts already receive `CLAUDE_SESSION_ID` via the hook payload; this variable makes the same value available to any Bash command the model runs, useful for correlating log output or scoping per-session state without requiring a hook intermediary.

### `CLAUDE_PROJECT_DIR` (v2.1.139)

Absolute path to the active project root. Hooks already received this value; v2.1.139 extends it to MCP stdio servers and to plugin command/`args:` strings, where `${CLAUDE_PROJECT_DIR}` is substituted at exec time. Use it for project-scoped paths in `.claude/settings.json` hook entries (the plugin's own hooks in `hooks/hooks.json` should keep using `${CLAUDE_PLUGIN_ROOT}`, which resolves to the installed plugin root and survives marketplace cache refreshes).

The bundled `omca` MCP stdio server inherits this variable through its environment; it reads state from `${HOOK_PROJECT_ROOT}` (set in `scripts/lib/common.sh`) rather than `${CLAUDE_PROJECT_DIR}` to preserve user overrides of the state directory. Renaming the internal variable is a separate concern with backward-compatibility implications and is not in scope here.

### `CLAUDE_EFFORT` (v2.1.133)

The active effort level (`low`, `medium`, `high`, `xhigh`, `max`) is injected into hook script environments and Bash tool subprocesses. Hook scripts can branch on effort to skip expensive operations when effort is `low`. Skills can reference `${CLAUDE_EFFORT}` in their content to communicate effort-aware instructions. Set the effort level via `/effort` or `--effort`.

### `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` (v2.1.132)

Set to `1` to opt out of the fullscreen alternate-screen renderer and keep the conversation in the terminal's native scrollback buffer. Useful for terminal multiplexers managing their own scrollback, or when capturing conversation output via pipe.

```bash
export CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1
claude
```

### `CLAUDE_CODE_FORK_SUBAGENT` (v2.1.119)

Set to `1` to enable forked subagents in non-interactive sessions. When forked, subagents inherit the FULL conversation context of the parent session instead of starting fresh. Useful for orchestration patterns where the subagent needs the orchestrator's accumulated context (e.g., a verifier reviewing the same payload the orchestrator just produced) without an explicit handoff prompt. Off by default on external builds; opt in per session.

### `ENABLE_PROMPT_CACHING_1H` (v2.1.108)

Set to `1` to opt API key, Bedrock, Vertex, and Foundry callers into the 1-hour prompt cache TTL (vs. the default 5-minute). Cuts cost on workflows with stable system prompts that get reused across many turns within an hour. OMCA orchestration falls into this pattern — the output-style body is identical for every session. Worth setting in user `~/.claude/settings.json` `env` block for cost-sensitive deployments.

### `CLAUDE_CODE_FORCE_SYNC_OUTPUT` (v2.1.129)

Force-enables synchronized output on terminals where auto-detection misses (notably Emacs `eat`). Reduces rendering glitches on rare terminal emulators. Set when you observe corrupted output or torn updates.

### `ANTHROPIC_API_KEY` / `apiKeyHelper` / `ANTHROPIC_AUTH_TOKEN` disable claude.ai features (v2.1.139)

When any of these are set, Remote Control, `/schedule`, claude.ai MCP connectors, and notification preferences are disabled — even if a Claude.ai OAuth login is also present in the session. API-key auth and Claude.ai auth resolve to different account scopes; the platform consistently picks API-key auth when both are set, so claude.ai-scoped features become unreachable.

OMCA's core workflows (ralph, ultrawork, start-work, F1-F4 verification) run in-process and do not depend on Remote Control or `/schedule`. Users who need claude.ai-only features must unset the API-key variable for that session.

### `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` (v2.1.154)

Set to `1` to enable the effort selector for all deployments, including those where it is
disabled by default (API key builds, certain managed tiers). Useful for ensuring
OMCA's effort-aware hook branching works when the platform would otherwise suppress the
effort control.

### `CLAUDE_CODE_ENABLE_AUTO_MODE` (v2.1.158)

Enables auto permission mode for Bedrock, Vertex, and AWS Bedrock Foundry deployments,
where it is off by default. Set to `1` to match the default-on behavior of claude.ai
builds. Relevant for OMCA users running in managed cloud deployments who want auto-mode
orchestration without the bypass-permissions confirmation flow.

### `agent` setting — honored for dispatched sessions (v2.1.157)

The `agent` key in `~/.claude/settings.json` (or project settings) is now honored for
dispatched (non-interactive) Claude Code sessions. When set, the named agent identity is
used for the dispatched session's system prompt. OMCA uses `templates/claudemd.md`
injection for sisyphus identity in interactive sessions; dispatched-session orchestration
is an advanced pattern not currently documented in OMCA's standard workflows.

### `fallbackModel` (v2.1.166)

Specifies a fallback model to use when the primary model is unavailable (e.g., capacity
limits). Set in `~/.claude/settings.json`:

```json
{
  "fallbackModel": "claude-sonnet-4-5"
}
```

Not OMCA-specific; standard platform setting. Relevant for deployments where opus
availability is not guaranteed.

### `requiredMinimumVersion` / `requiredMaximumVersion` (v2.1.163)

Managed keys that enforce a minimum or maximum Claude Code version for the deployment.
These are org-policy keys — OMCA cannot set or override them. If your org enforces a
minimum version, ensure it is ≥ v2.1.141 to get the full v2.1.141–v2.1.167 sync
feature set.

### `CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE` — removed (v2.1.160)

This env var was deprecated in v2.1.154 and removed in v2.1.160. OMCA never referenced
it; no action needed.

---

## Observability and OTEL Attribution

### Subagent attribution (v2.1.139+)

Subagent API requests carry two request headers, and `claude_code.llm_request` OTEL spans carry the matching span attributes:

| Surface | Field | Meaning |
|---|---|---|
| HTTP header | `x-claude-code-agent-id` | This subagent's agent ID |
| HTTP header | `x-claude-code-parent-agent-id` | The spawning agent's ID (main session or the subagent's parent) |
| OTEL span attribute | `agent_id` | Same as the `x-claude-code-agent-id` header |
| OTEL span attribute | `parent_agent_id` | Same as the `x-claude-code-parent-agent-id` header |

OMCA does not configure OTEL by default. With an OTEL collector wired up, subagent token usage and latency can be attributed to specific OMCA agents (sisyphus, prometheus, executor, oracle, explore, etc.) instead of one undifferentiated `claude_code.llm_request` stream.

---

## Managed Settings Boundary

This plugin is not the policy authority. Managed settings own non-overridable org controls.

Important keys:

| Key | Purpose |
|-----|---------|
| `strictKnownMarketplaces` | Allow only approved marketplaces |
| `blockedMarketplaces` | Deny specific marketplaces |
| `allowManagedHooksOnly` | Allow only managed hooks |
| `allowManagedPermissionRulesOnly` | Allow only managed permission rules |
| `allowManagedMcpServersOnly` | Allow only managed MCP servers |
| `sandbox.failIfUnavailable` | Fail if sandbox cannot start (fail-closed posture) |
| `parentSettingsBehavior` | (v2.1.133, managed settings only) Controls whether SDK/IDE parent-supplied managed settings apply when an admin-deployed managed tier is also present. `"first-wins"` (default): parent settings are dropped, admin tier wins. `"merge"`: parent settings apply under admin tier, filtered to tighten policy only. Has no effect when no admin tier is deployed. |
| `sandbox.bwrapPath` | (v2.1.133, managed settings only, Linux/WSL) Absolute path to a custom `bubblewrap` binary used for sandboxed Bash execution. Override when the system `bwrap` is missing, too old, or replaced by a hardened build. |
| `sandbox.socatPath` | (v2.1.133, managed settings only, Linux/WSL) Absolute path to a custom `socat` binary. Companion to `bwrapPath` — used by the sandbox's networking proxy. Override under the same conditions. |

Keep `teammateMode: "auto"` as the default collaboration baseline unless your org policy overrides it.

`scripts/permission-filter.sh` does not auto-allow arbitrary commands — it only auto-approves
known-safe package managers (npm, yarn, pnpm, bun), jq, and uv run/sync, and blocks
destructive patterns (rm -rf).

`/oh-my-claudeagent:omca-setup` inspects and reports on these keys but cannot write them.

---

## Output Styles

### `force-for-plugin` (re-verified 2026-06-06)

`output-styles/omca-default.md` uses `force-for-plugin: true` in its frontmatter.
This key is live and documented in the platform output-styles reference: it causes the
plugin's output style to apply automatically whenever the plugin is enabled, without
requiring the user to select it, and overrides the user's `outputStyle` setting. If
multiple enabled plugins set `force-for-plugin: true`, the platform uses the first one
loaded.

**GFM task-list checkboxes (v2.1.149):**

GitHub Flavored Markdown task-list checkboxes (`- [ ]` / `- [x]`) now render visually
in model responses. OMCA plan files use checkbox syntax (`- [ ] N. Task`) and these now
render in-session. No OMCA file changes required; this is a platform rendering improvement.

---

## Deliberate Non-Adoptions (v2.1.141–v2.1.167)

Features introduced in this window that OMCA consciously declines to adopt:

| Feature | Version | Reason |
|---------|---------|--------|
| `hookSpecificOutput.additionalContext` on Stop/SubagentStop | v2.1.163 | Co-existence with `decision:block` is undocumented (schema inconclusive); exit-2 path ignores all JSON — `additionalContext` would be silently dropped alongside a block decision |
| `MessageDisplay`, `Elicitation`, `ElicitationResult`, `Setup` hook handlers | v2.1.152 | No OMCA use case; tracked in `new_platform_events` validator array (skip-on-absent semantics). Blocking PostToolBatch semantics (`decision:block`) deferred to v2 — current handler is non-blocking `additionalContext` only |
| `PostToolBatch` blocking semantics (v2) | v2.1.152 | v1 non-blocking handler adopted in v2.7.0; blocking `decision:block` behavior deferred — not documented to co-exist with batch continuation, behavior unvalidated in production |
| `skills:` preload frontmatter | v2.1.150 | Adds context-window cost on every session; OMCA's lazy slash-command / keyword paths are sufficient |
| `Agent(type=...)` spawn-allowlist in agent frontmatter | v2.1.148 | Sisyphus needs unrestricted spawn access to the full agent roster; an allowlist would require updating on every new specialist addition |
| `defaultEnabled: false` in plugin.json | v2.1.154 | OMCA is designed to activate immediately on install; inactive-by-default would break first-session experience |
| `reloadSkills` in SessionStart output | v2.1.152 | No OMCA use case identified |
| `prompt`, `agent`, and `http` hook types | (standing) | Orthogonal to OMCA's bash-script hook model |
| Monitors, Themes, Channels, LSP | (standing) | No current OMCA use case |
| `arguments:` in skill frontmatter | evaluated 2026-06 | Shell-style positional binding truncates free-form input — a slash command like `/ralph fix the auth bug` would bind only `$task="fix"`, discarding the rest. OMCA skills receive the full user prompt via natural expansion instead |
| `hooks:` in skill frontmatter | evaluated 2026-06 | Persistence loops (ralph, ultrawork) outlive skill-active windows; skill-frontmatter hooks are not visible to `validate-plugin.sh`. All hook registration stays in `hooks/hooks.json` |
| `skillOverrides` / `skillListingBudgetFraction` / `maxSkillDescriptionChars` settings | evaluated 2026-06 | User-preference settings only; `skillOverrides` does not apply to plugin-shipped skills. No plugin-side adoption possible or needed |
| `initialPrompt` in agent frontmatter | evaluated 2026-06 | Fires an unconditional billable model turn per subagent; `subagent-start.sh` already injects boulder context as `additionalContext` at zero turn cost |
| `SessionStart` `watchPaths` output | evaluated 2026-06 | `FileChanged` consumer is side-effects-only (log + notify); no runtime reader benefits from an expanded watch set |
| `PostToolUse` `updatedToolOutput` | evaluated 2026-06 | Rewriting tool output post-hoc is adversarial to evidence integrity — OMCA's verification model requires the model to see literal command output |
| `plugin.json` `dependencies` field | evaluated 2026-06 | OMCA has no runtime inter-plugin dependencies; field has no consumers in this plugin |
| MCP `headersHelper` and WebSocket (`ws`) transport | evaluated 2026-06 | All OMCA MCP servers use stdio; no auth-header injection or WebSocket transport needed |

**Platform-prohibited (skipped, not evaluated):**

| Feature | Reason |
|---------|--------|
| `sessionTitle` output on `UserPromptSubmit` | Platform contract: `sessionTitle` is a `SessionStart`-only output field. Emitting it from `UserPromptSubmit` (or any other hook) is unsupported by spec; the platform ignores it outside startup/resume |

**Adopted in 2026-06 sweep:**

| Feature | Adopted in | Notes |
|---------|-----------|-------|
| `duration_ms` coaching in `bash-error-recovery.sh` | v2.7.0 | Added two branches: text-regex timeout detection (placed first in deterministic chain) and `duration_ms` ≥ 120 s fallback for slow-failure coaching (run_in_background / larger-timeout / narrower-scope). Payload probe confirmed `duration_ms` present in PostToolUseFailure Bash payloads |
| `delegate-retry.sh` `duration_ms` branch | deferred | Agent-failure PostToolUseFailure payload structure not confirmed by probe contract — `duration_ms` coverage for Agent failures is pending a dedicated probe session |
| `statusLine.refreshInterval: 5` | v2.7.0 | Applied via `omca-setup` Phase 5.6; both create and merge jq variants updated. Rationale: disk-sourced statusline reads git cache files that update on a ~5 s cadence; background-agent idle scenarios benefit from a matching refresh ceiling. Doc-claim ceiling: freshness improvement covers disk-sourced and idle-fan-out scenarios only |

---

## Verification

When updating plugin docs or runtime contracts, verify with:

```bash
bash scripts/validate-plugin.sh
just test-hooks
```

Full CI pipeline:

```bash
just ci    # fmt-check + lint + test
```
