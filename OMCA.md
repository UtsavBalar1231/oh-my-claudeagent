# oh-my-claudeagent — Complete Guide

Plugin for Claude Code adding multi-agent orchestration: specialist agents, slash-command/keyword skills, hook-driven persistence, MCP servers for structural search and state tracking.

Install: `README.md`. Contributor internals: `CLAUDE.md`.

---

## What Is This

Claude Code runs single-threaded. Simultaneous research + implementation, or ten files needing fixes at once, bottleneck the default session. No built-in specialist delegation or persistence guarantee.

OMCA adds a multi-agent layer: specialist agents with model tiers (claude-opus-4-8/sonnet/haiku), skills via slash commands or keywords, hooks for persistence and context injection, MCP servers for structural search and state.

### Philosophy

Delegate to specialists, verify with evidence, ship with confidence. Core loop: explore → plan → execute in parallel → verify. Every agent delegates or implements — never both. Every claim requires evidence.

---

## Ownership Model

**Claude-native**: plan mode, memory, hooks, plugin schema, permissions, sandboxing, subagents, teams, `claude agents` agent view (Research Preview, v2.1.139+), `/goal` completion-condition loop (v2.1.139+).

**OMCA**: agent prompts, orchestration policy, skill prompts, keyword activation, evidence discipline (one completeness check), `omca` MCP server (ast tools, boulder, evidence, notepad, file_read), stateless guardrail hooks, execution metadata in `.omca/state/` and `.omca/logs/`.

Claude-native plans (`~/.claude/plans/` or the active plan-mode file) are canonical. `.omca/plans/` remains a supported compatibility mirror/resume surface maintained by boulder, not the primary authored plan surface.

**`/goal` vs `/oh-my-claudeagent:start-work`**: `/goal` is a native completion-condition loop. `/start-work` pairs with boulder state and evidence gating for plan-driven work. For timer-based re-runs, use native `/loop` — it is not a verified persistence loop, but it is the lightest way to keep running until you manually stop.

**Channels**: Not used — OMCA focuses on in-session orchestration via hooks, subagents, skills.

---

## Core Concepts

### Agents

Markdown files in `agents/*.md` with YAML frontmatter (name, model, disallowedTools, behavior). Addressable via `Agent(subagent_type="oh-my-claudeagent:NAME")`.

**Model tiers:**

| Tier | Default for | Use for |
|------|-------------|---------|
| claude-opus-4-8 | Orchestrators, planners, reviewers | Complex reasoning, architecture, multi-step coordination |
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

Keywords are the natural interaction model. Type "create plan" or "fix build" in any prompt and the corresponding skill activates automatically. Slash commands are also available for explicit invocation.

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
(e.g., `/oh-my-claudeagent:plan fix the auth bug` → `$task="fix"`). OMCA does not adopt
`arguments:` because shell-style positional binding truncates free-form input: only the
first token is bound, making it unsuitable for narrative task descriptions. OMCA skill
bodies receive the full user prompt via the platform's natural expansion path instead.

**`hooks:` frontmatter (v2.1.141–v2.1.167, not adopted):**

SKILL.md files can declare a `hooks:` block to register hook handlers that are active
only while the skill is running. OMCA does not adopt this because hooks declared in
skill frontmatter are invisible to `scripts/validate-plugin.sh`, which validates hooks
only from `hooks/hooks.json`. All OMCA hook registration stays in `hooks/hooks.json`.

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
`ultracode` in v2.1.157. OMCA does not reference the platform keyword;
no OMCA files are affected.

### Hooks

Hooks are bash scripts in `scripts/*.sh`, registered in `hooks/hooks.json`. They run on
Claude Code lifecycle events and provide:

- Context injection (AGENTS.md, rules, notepad directives)
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
| `TaskCompleted` | Task lifecycle |
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

`TaskCreated` and `TeammateIdle` are platform task-collaboration lifecycle events OMCA
does not currently hook — `scripts/teammate-idle-guard.sh` no longer exists, and no
script registers `TaskCreated`. Only `TaskCompleted` is registered among the three
(`task-completed-verify.sh`, the evidence-gating handler).

**New platform events (v2.1.141–v2.1.167):**

| Event | Added | Status | Notes |
|-------|-------|--------|-------|
| `MessageDisplay` | v2.1.152 | Not adopted | Display-only terminal overlay; `displayContent` never reaches the transcript or context. Re-confirmed not-adopted 2026-07-01: screen/transcript divergence conflicts with evidence-first design, and every candidate use serves better via durable `additionalContext`/evidence |
| `PostToolBatch` | v2.1.152 | Not adopted (removed) | Still a valid platform event in v2.1.197; OMCA's handler was removed in the v2.10 minimize-to-core refactor — see footnote below |
| `Elicitation` | v2.1.152 | Not adopted | Fires when the model issues an elicitation request |
| `ElicitationResult` | v2.1.152 | Not adopted | Fires with the elicitation response |
| `Setup` | v2.1.152 | Not adopted | Plugin initialization event |

The non-adopted events are tracked in `validate-plugin.sh`'s `new_platform_events` array
(introduced v2.1.141–v2.1.167 sync). The validator skips them when no handler is present and
passes when one is present — no failures on absence.

**PostToolBatch history:** implemented in v2.7.0 as `scripts/post-tool-batch.sh`
(same-file parallel-edit warnings, batch-consolidated delegation reminder, and the
`agent-usage-reminder.sh` per-call-to-per-batch migration); removed in the v2.10
minimize-to-core refactor along with `agent-usage-reminder.sh` — neither script exists
in the current tree.

**Stop / SubagentStop — new input fields (v2.1.145):**

The Stop and SubagentStop hook payloads now include two additional fields:

| Field | Type | Notes |
|-------|------|-------|
| `background_tasks` | array | Platform-managed background tasks running at Stop time |
| `session_crons` | array | Scheduled cron jobs registered for the session |

OMCA's Stop hook (`final-verification-evidence.sh`) does not consult these fields — it checks only boulder state and evidence. Background tasks are orthogonal to the completeness check. (Verified by test: the v2.1.145 Stop payload change has zero behavioral impact on OMCA hooks.)

**Stop / SubagentStop — `additionalContext` output (v2.1.163):**

Hooks can now return `hookSpecificOutput.additionalContext` from Stop / SubagentStop.
OMCA deliberately does not adopt this: co-existence with `decision:block` is not
documented (schema inconclusive); exit-2 paths ignore all JSON output entirely, so any
`additionalContext` alongside a block decision would be silently dropped.
(See "Deliberate non-adoptions" section below for the non-adoption log.)

**SessionStart — new output fields (v2.1.152):**

`SessionStart` hooks can return two new fields:

| Field | Adopted by OMCA | Notes |
|-------|----------------|-------|
| `sessionTitle` | Yes — `session-init.sh` emits `"OMCA: <plan_name>"` when boulder is active | Sets the session title in the platform UI |
| `reloadSkills` | No | Boolean; forces a skill reload on session start — no OMCA use case |

**Stop hook block cap (v2.1.143):**

The platform enforces a maximum of 8 consecutive Stop blocks per session. The cap is
configurable via `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (env var). OMCA's Stop hook
(`final-verification-evidence.sh`) does not block the Stop event unless the plan
is complete but evidence is missing — it never emits a persistence-style block.
(Adopted in the v2.1.141–v2.1.167 sync.)

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
- `bin/omca-status` — print active boulder, evidence summary, and plan completion status
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
5. For timer-based re-runs: use `/loop 10m /oh-my-claudeagent:start-work`
   — native `/loop` is a lightweight repeat, not a verified persistence loop
6. When context is long: type "handoff"
   — A structured session summary is produced for pasting into a new session

---

## Agent Reference

### Orchestrator

| Agent | Model | Effort | Invoke | Purpose |
|-------|-------|--------|--------|---------|
| sisyphus | claude-opus-4-8 | high | Main session (injected via `templates/claudemd.md`) or `/oh-my-claudeagent:start-work` (Plan Execution Mode) | Master orchestrator identity — classifies requests, delegates to specialists. Two modes: free-form (conversational) and plan-driven (via `/start-work` command body). Plan Execution Mode protocol lives in `commands/start-work.md`. |

**sisyphus** — The one orchestrator. Free-form mode: routes requests to specialists, runs explore agents in background. Plan Execution Mode: reads plan, delegates per-task to `executor`, logs evidence, runs a final completeness check at the end.

### Planning and Review

| Agent | Model | Effort | Invoke | Purpose |
|-------|-------|--------|--------|---------|
| prometheus | claude-opus-4-8 | high | `/oh-my-claudeagent:plan` or "create plan" | Strategic planning with requirements interview + optional Socratic Interview Mode |
| metis | claude-opus-4-8 | high | `/oh-my-claudeagent:metis` or "run metis" | Pre-planning gap analysis |
| momus | claude-opus-4-8 | high | `Skill(oh-my-claudeagent:momus)` (or `Agent(subagent_type="oh-my-claudeagent:momus")` from the main session) | Rigorous plan review — OKAY or REJECT |
| oracle | claude-opus-4-8 | max | `Agent(subagent_type="oh-my-claudeagent:oracle")` | Architecture advisor, read-only |

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
ast-grep, evidence-gated completion.

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
   -> Final completeness check via final-verification-evidence.sh

4. Resume after interruption with /oh-my-claudeagent:start-work
   -> Boulder state resumes from last completed task
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
| `boulder_write` | Register an active work plan and accumulate session IDs across resumes |
| `boulder_progress` | Check completed vs remaining tasks for the active plan |

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
(v2.1.141–v2.1.167 sync).

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

- `state/boulder.json` — Session-bound plan registry: one entry per plan under `plans[plan_name]`, one binding per session under `bindings[session_id]`
- `evidence/verification-evidence.json` — Verification records
- `state/active-modes.json` — Keyword detection session tracking (re-announce suppression)
- `state/compaction-context.md` — Saved state for compaction survival
- `state/injected-context-dirs.json` — Per-session dedup keys for AGENTS.md/README.md and `.omca/rules/*.md` context injection, reset every `SessionStart`
- `state/subagent-models.json` — Live subagent id → resolved model name, for the statusline renderer
- `state/notepads/{plan-name}/` — Per-plan notepad sections
- `plans/{name}.md` — Compatibility mirror/resume surface for native plans, maintained by boulder
- `logs/` — Session, edit, and subagent audit logs
- `rules/*.md` — Project rules (auto-injected on file match)

### Boulder Lifecycle

`boulder.json` is a session-bound plan **registry**, not a single-plan pointer: multiple
plans can be tracked concurrently under `plans[plan_name]`, and each session binds to
exactly one of them via `bindings[session_id]`. See `.claude/rules/state-schemas.md` for
the full schema and the `resolve_bound_plan` ladder.

1. Prometheus creates a plan at `~/.claude/plans/{name}.md` or the active plan-mode file
2. `boulder_write(active_plan, plan_name, session_id)` upserts `plans[plan_name]` (preserving `started_at`, appending `session_id` to `session_ids`) and binds this session to it; `.omca/plans/` mirrors the plan for compatibility
3. `/start-work` reads `boulder_progress()` (resolves the calling session's bound plan when no explicit `plan_path`/`plan_name` is given) to resume from the last completed task
4. Sisyphus/start-work checks `boulder_progress` to track which tasks remain
5. The final-verification-evidence.sh Stop hook resolves this session's bound plan and confirms a matching `final_verification` evidence entry exists when that plan's checkboxes show it complete
6. `SessionEnd` (`session-cleanup.sh`) removes only the ending session's binding; a plan itself is never deleted while incomplete or still bound by another session. A 7-day age backstop in `boulder_write`'s `_gc_prune()` also prunes stale bindings and unbound, checkbox-complete plans, for sessions that never hit a clean `SessionEnd`

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

- **Free-text triggers** — `keyword-detector.sh` fires on `UserPromptSubmit`, pattern-matches the raw prompt text (e.g., "create plan", "fix build"), and injects context.
- **Slash-command triggers** — `slash-command-mode-detector.sh` fires on `UserPromptExpansion`, reads `command_name` directly (e.g., `oh-my-claudeagent:hephaestus`), and activates the corresponding mode without relying on the expanded body's wording. This is more reliable: mode activation works regardless of what the skill's SKILL.md body says.

Both paths share the same `active-modes.json` schema and session-aware re-announce suppression (`mode_already_announced` / `mark_mode_announced` in `scripts/lib/common.sh`). If both fire for the same mode in the same session, the second invocation suppresses silently.

The `keyword-detector.sh` hook fires on `UserPromptSubmit`, pattern-matches against
known phrases, and injects context that triggers the corresponding skill.

Keywords are the natural interaction model — type natural phrases in any prompt.

### Full Keyword Map

| Keyword / Phrase | Activates |
|------------------|-----------|
| `handoff`, `context is getting long`, `start fresh session` | session handoff |
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

## Session Continuity

### Compaction Survival

When the context window fills, the plugin preserves state across compaction via a
three-script pipeline: `pre-compact.sh` (PreCompact) saves state, `post-compact-log.sh`
(PostCompact) logs it, and `post-compact-inject.sh` fires on `SessionStart` with reason
`compact` — not on PostCompact. Active plans and task state survive compaction.

### StopFailure Limitation

`StopFailure` fires on API errors and is logging-only — hooks cannot block it. If an API
error interrupts a plan run, manually resume with `/oh-my-claudeagent:start-work`.

---

## Troubleshooting

**MCP tools not available:** Check `ast-grep`/`sg` and `uv` are installed. Run
`/oh-my-claudeagent:omca-setup --check`. Run `/reload-plugins` to restart MCP servers.

**Subagent nesting depth:** `/oh-my-claudeagent:start-work` runs inline in the main
session at depth 0 with full `Agent`-tool access. Parallel fan-out and specialist delegation
all work. The command body in `commands/start-work.md` is the authoritative Plan Execution
Mode protocol. There is no degraded mode — orchestration only runs at depth 0 by design.
The `atlas` agent was removed in v2.0; its plan-execution protocol migrated to the command
body, its orchestrator role consolidated into `sisyphus` (the main-session identity).

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

OMCA's core workflows (start-work, evidence gating, specialist delegation) run in-process and do not depend on Remote Control or `/schedule`. Users who need claude.ai-only features must unset the API-key variable for that session.

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
  "fallbackModel": ["claude-sonnet-5", "claude-haiku-4-5"]
}
```

`fallbackModel` accepts up to 3 models (v2.1.166), tried in order until one is reachable.

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

## OMC (oh-my-claudecode) Adoptions

A sibling project, oh-my-claudecode (OMC), independently solved several problems OMCA
also has. This sync ported five of its ideas, adapted to OMCA's bash+Python idiom rather
than copied verbatim.

**Adopted:**

| Feature | Notes |
|---------|-------|
| Session-bound plan registry | `boulder.json` moved from a single `active_plan` pointer to `{plans: {<plan_name>: {...}}, bindings: {<session_id>: {plan_name, bound_at}}}`. Fixes the clobber where two concurrent sessions working different plans overwrote each other's state. `resolve_bound_plan()` (`servers/tools/_boulder_core.py`) is the one pure-read resolution ladder every consumer calls, via direct import in Python or the `boulder_resolve.py` shim from bash. See `.claude/rules/state-schemas.md` for the full schema |
| drift-guard hard-block Stop hook | New `scripts/drift-guard.sh`: when the last assistant turn reads as a completion claim ("done", "fixed", "implemented", etc., unless negated) but the diff still contains a stub marker (`.only`, `TODO: implement`, an unimplemented-error throw), the Stop is blocked with the offending `file:line`. Self-clearing — fixing the stub removes the marker, so there is no separate loop-guard state file. Kill-switch: `OMCA_HOOK_DISABLE_DRIFT_GUARD` |
| context-injector hardening | `scripts/context-injector.sh` now dedups injections by content-hash+realpath (reusing `injected-context-dirs.json`, which `session-init.sh` already resets every `SessionStart`) instead of re-injecting on every matching file access. The project-root walk for both the `.omca/rules` scan and the AGENTS.md/README terminator now resolves worktree-safely (a linked worktree's `.git` is a file, not a directory, so the walk tests `-e` not `-d`), so a worktree session no longer walks up into the parent repo |
| stdin-read timeout | `scripts/lib/common.sh`'s shared `HOOK_INPUT=$(cat)` read now wraps in `timeout 5 cat`, discarding on exit 124 rather than hanging indefinitely if stdin is never closed. Blocking hooks (`final-verification-evidence.sh`, `drift-guard.sh`, `task-completed-verify.sh`) treat an empty-from-timeout read as fail-closed-or-warn, not a silent pass |
| Compaction content round-trip | `pre-compact.sh` now inlines the session's next 10 unchecked plan tasks and the 5 most recent notepad decisions (tasks first, so they survive `post-compact-inject.sh`'s downstream line cap), instead of leaving compaction to rely on whatever the model happened to keep in its own summary |
| Per-subagent statusline model | `subagent-start.sh` now records each live subagent's resolved display model (e.g. `Sonnet`, `Opus 4.8`) in `subagent-models.json`; the statusline renders it per running task instead of showing only the parent session's model |

**Reframed, not ported as-is:**

- **Directives via Claude-native memory, not a new store.** OMC persists standing user
  directives ("always run tests before claiming done") in its own dedicated store. OMCA
  already has a durable, cross-session store for exactly this: Claude-native project
  memory. Rather than build a second directives mechanism, the relevant agents'
  `## Memory Guidance` sections and `output-styles/omca-default.md` now name standing
  directives as an explicit `feedback`-type memory save trigger. No new file, no new
  re-injection path.
- **Context-injector hardening stopped at hardening.** OMC's version also adds
  multi-source injection (pulling context from more than `.omca/rules/*.md` and
  AGENTS.md/README). OMCA only adopted the dedup and worktree-root fixes; multi-source
  injection was not a problem OMCA had, so it was left out rather than adding unused
  surface area.

**Task 0 runtime findings** (probed before building on top of them; full detail in
`.omca/notes/probe-runtime-semantics.md`):

- The `Stop` hook payload carries `transcript_path`, not an inline `messages` array, so
  drift-guard tails the transcript JSONL and reads the last `assistant`-type record's
  `message.content`, rather than reading a message list directly off the payload.
- When multiple `Stop` hooks are registered, the platform dispatches all of them in
  parallel — one hook's exit code can never short-circuit a sibling's execution, and any
  single hook exiting 2 blocks the stop regardless of what the others return. drift-guard
  was built to be correct standing alone, with no assumption about ordering relative to
  `final-verification-evidence.sh`.
- `CLAUDE_CODE_SESSION_ID` is the confirmed binding key for anything running as an MCP
  tool or agent process (live-observed in-session); bash hook scripts keep the existing
  three-tier fallback (`CLAUDE_SESSION_ID` env, then the hook payload's `session_id`,
  then `session.json`) since the hook-side env var was not independently confirmed.

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
| `arguments:` in skill frontmatter | evaluated 2026-06 | Shell-style positional binding truncates free-form input — a slash command like `/oh-my-claudeagent:plan fix the auth bug` would bind only `$task="fix"`, discarding the rest. OMCA skills receive the full user prompt via natural expansion instead |
| `hooks:` in skill frontmatter | evaluated 2026-06 | Skill-frontmatter hooks are not visible to `validate-plugin.sh` (validates hooks only from `hooks/hooks.json`). All hook registration stays in `hooks/hooks.json` |
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

**Adopted this sync (v2.1.168–v2.1.197):**

| Feature | Notes |
|---------|-------|
| `[1m]` auto-strip alignment | v2.1.173 dropped the `[1m]` context-window suffix from model identifiers platform-side; OMCA's agent docs and tables now use bare `claude-opus-4-8` throughout |
| Per-agent `effort:` tuning | Agent Reference table effort levels (high/max) reviewed and kept; no regressions found against v2.1.197 effort semantics |
| `sessionTitle` from boulder.json | Already adopted (v2.1.152, `session-init.sh`); re-verified against v2.1.197 and now guarded against an absent boulder file |
| Model generation move | Agent docs reference the current generation: sonnet-5, opus-4-8, haiku-4-5 |

**Provider-alias caveat:** the `sonnet` alias resolves to claude-sonnet-5 on the Anthropic
API (confirmed v2.1.197+). Bedrock resolves `sonnet` to Sonnet 4.5; AWS Platform resolves
it to 4.6. OMCA's worker agents keep the bare `sonnet` alias in `model:` frontmatter
(portable across providers); users running non-Anthropic providers who need a specific
generation should pin an explicit model ID in their own settings rather than relying on
the alias.

**Nesting invariant (v2.1.172):** the platform raised the max agent spawn depth to 5.
OMCA's own spawn graph stays at depth 2 — only `sisyphus`, `executor`, and `prometheus`
spawn further subagents; every other agent declares `disallowedTools: Agent`. No change
needed; documented here so the depth-5 platform cap isn't mistaken for an OMCA target.

**Deliberate non-adoptions (v2.1.168–v2.1.197):**

| Feature | Version | Reason |
|---------|---------|--------|
| `type: agent` / `type: prompt` semantic evidence verifier on `TaskCompleted` | v2.1.197 spec | NO-GO. Evaluated in `.omca/notes/spike-semantic-verification-hooks.md`. Docs mark `type: agent` experimental/may-change; would roughly double LLM call volume on the task-completion path versus the existing zero-cost bash+jq gate (`task-completed-verify.sh`); targets a hypothetical mismatch failure mode with no observed incident history, while the existing deterministic hard gates (schema + freshness checks) already cover the failure modes actually seen in production. Re-evaluate only if `type: agent` graduates out of experimental and a real semantic-mismatch incident is observed |
| `worktree.bgIsolation` | v2.1.143 | Claude-native owns worktree isolation policy; OMCA documents the `worktree.baseRef` hazard (see CLAUDE.md) but does not set this key — no OMCA workflow depends on background-isolation defaults differing from the platform default |
| `sandbox.credentials` | v2.1.187 | Managed-settings-adjacent credential-scoping key; outside OMCA's ownership boundary (sandboxing is Claude-native's domain per the Ownership Model above) |
| `autoMode.classifyAllShell` | v2.1.193 | Would route every Bash call through the auto-mode classifier, not just unmatched ones; OMCA's `permission-filter.sh` already fast-paths known-safe tooling deterministically — classifying all shell calls would add latency without changing OMCA's allow/deny outcomes |
| `enforceAvailableModels` | v2.1.175 | Ordering hazard: this setting hard-fails on any stale model reference. Safe to enable only after all stale model IDs are purged from a deployment's settings and agent frontmatter (this sync's `[1m]` strip and model-generation update is exactly that purge). OMCA documents the setting but does not enable it by default — enabling is a user decision once their own config is clean |
| `fallbackModel[]` | v2.1.166 | Documented above under Environment Variables; not auto-set by OMCA because the right fallback chain depends on the user's model availability and provider, which OMCA cannot infer |
| `disableBundledSkills` | v2.1.169 | User-preference key for suppressing platform-bundled skills; orthogonal to OMCA's own skill set, no plugin-side action needed |
| `autoMode` destructive-git default-block | v2.1.183 | Overlaps OMCA's own `scripts/git-master`-adjacent destructive-git denial in `permission-filter.sh` (`sudo rm -rf` guardrail). Complementary, not adopted as a replacement — OMCA's hook runs regardless of `autoMode` state |
| `Agent(type)` deny enforcement | v2.1.186 | No OMCA agent declares a `type` field; nothing to enforce against yet |
| Nested `.claude/` closest-wins precedence | v2.1.178 | Affects multi-root or nested-project layouts; OMCA's state lives under a single `.omca/` root per `CLAUDE_PROJECT_DIR` and does not nest |
| Background-subagent permission-prompt | v2.1.186 | Background `Agent` calls now surface permission prompts the same as foreground; this is platform UX, not a setting OMCA wires |
| Scheduled/webhook trigger reclassification | v2.1.183 | Claude-native owns `/schedule` triggers (see Ownership Model); OMCA's evidence/boulder state does not interact with trigger firing |

**Cost-governance recommendation (v2.1.178):** the `Tool(param:value)` permission syntax
(e.g. `Agent(model:opus)`) restricts a tool call's parameters at the permission-rule level.
Users running cost-sensitive deployments can add an allow/deny rule scoped to
`Agent(model:opus)` in their own `settings.json` to cap which subagents may spawn at the
opus tier, independent of what model each OMCA agent's frontmatter requests. This is a
user-side recommendation — OMCA's shipped `settings.json` does not set it, since the
right cap depends on the deployment's budget, not on OMCA's orchestration logic.

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
