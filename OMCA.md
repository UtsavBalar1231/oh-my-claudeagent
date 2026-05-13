# oh-my-claudeagent — Complete Guide

Plugin for Claude Code adding multi-agent orchestration: specialist agents, slash-command/keyword skills, hook-driven persistence, MCP servers for structural search and state tracking.

Install: `README.md`. Contributor internals: `CLAUDE.md`.

---

## What Is This

Claude Code runs single-threaded. Simultaneous research + implementation, or ten files needing fixes at once, bottleneck the default session. No built-in specialist delegation or persistence guarantee.

OMCA adds a multi-agent layer: specialist agents with model tiers (opus/sonnet/haiku), skills via slash commands or keywords, hooks for persistence and context injection, MCP servers for structural search and state.

### Philosophy

Delegate to specialists, verify with evidence, ship with confidence. Core loop: explore → plan → execute in parallel → verify. Every agent delegates or implements — never both. Every claim requires evidence.

---

## Ownership Model

**Claude-native**: plan mode, memory, hooks, plugin schema, permissions, sandboxing, subagents, teams.

**OMCA**: agent prompts, orchestration policy, skill prompts, keyword activation, verification discipline, `omca` MCP server, session persistence (ralph, ultrawork), execution metadata in `.omca/state/` and `.omca/logs/`.

Both `.omca/plans/` and native plan files valid. Prometheus generates to `.omca/plans/`; Claude-native plan mode works alongside.

**Channels**: Not used — OMCA focuses on in-session orchestration via hooks, subagents, skills.

---

## Core Concepts

### Agents

Markdown files in `agents/*.md` with YAML frontmatter (name, model, disallowedTools, behavior). Addressable via `Agent(subagent_type="oh-my-claudeagent:NAME")`.

**Model tiers:**

| Tier | Default for | Use for |
|------|-------------|---------|
| opus | Orchestrators, planners, reviewers | Complex reasoning, architecture, multi-step coordination |
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
   — Atlas picks up the plan and delegates tasks to executor in parallel
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
| sisyphus | opus | high | Main session (injected via `templates/claudemd.md`) or `/oh-my-claudeagent:start-work` (Plan Execution Mode) | Master orchestrator identity — classifies requests, delegates to specialists. Two modes: free-form (conversational) and plan-driven (via `/start-work` command body). Plan Execution Mode protocol lives in `commands/start-work.md`. |

**sisyphus** — The one orchestrator. Free-form mode: routes requests to specialists, runs explore agents in background. Plan Execution Mode: reads plan, delegates per-task to `executor`, runs Final Verification Wave (F1 via oracle, F2-F4 via executor), waits for sign-off.

### Planning and Review

| Agent | Model | Effort | Invoke | Purpose |
|-------|-------|--------|--------|---------|
| prometheus | opus | high | `/oh-my-claudeagent:plan` or "create plan" | Strategic planning with requirements interview + optional Socratic Interview Mode |
| metis | opus | high | `/oh-my-claudeagent:metis` or "run metis" | Pre-planning gap analysis |
| momus | opus | high | `Agent(subagent_type="oh-my-claudeagent:momus")` | Rigorous plan review — OKAY or REJECT |
| oracle | opus | max | `Agent(subagent_type="oh-my-claudeagent:oracle")` | Architecture advisor, read-only |

**prometheus** — 9-item clearance checklist interview, consults metis, generates plan,
submits to momus for review (up to 3 iterations). Optional Socratic Interview Mode for
ambiguous or architectural requests: iterative dialogue, synthesis stop-criterion, does NOT
write to `.claude/plans/` (research output only).

**metis** — Classifies intent, explores codebase, identifies hidden requirements and scope
risks. Invoked automatically by prometheus.

**momus** — Evaluates plans against 5 criteria. Approval bias: 80% clear is good enough.

**oracle** — Read-only. Dense output: bottom line in 2-3 sentences, action plan in 7
steps max, effort estimates (Quick/Short/Medium/Large).

### Search and Research

| Agent | Model | Effort | Invoke | Purpose |
|-------|-------|--------|--------|---------|
| explore | sonnet | medium | `Agent(..., run_in_background=true)` | Codebase search — files, patterns, implementations |
| librarian | sonnet | medium | `Agent(..., run_in_background=true)` | External docs, OSS examples, library research |

**explore** — Always run in background. Uses ast_search, Grep, Glob. Fire multiple in
parallel for broad searches.

**librarian** — Uses context7 for library docs, clones repos for source investigation.

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
| `boulder_write` | Register active plan |
| `boulder_progress` | Check completed vs remaining tasks |
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

---

## Runtime State

All runtime state lives in `.omca/` (gitignored by default):

- `state/boulder.json` — Active work plan (managed by omca MCP)
- `state/verification-evidence.json` — Verification records
- `state/ralph-state.json` — Ralph persistence state
- `state/compaction-context.md` — Saved state for compaction survival
- `state/notepads/{plan-name}/` — Per-plan notepad sections
- `plans/{name}.md` — Prometheus-generated work plans
- `logs/` — Session, edit, and subagent audit logs
- `rules/*.md` — Project rules (auto-injected on file match)

### Boulder Lifecycle

1. Prometheus creates a plan at `.omca/plans/{name}.md`
2. `boulder_write(active_plan, plan_name, session_id)` registers it
3. `/start-work` reads boulder state and resumes from last incomplete task
4. Atlas uses `mode_read` and `boulder_progress` to track execution
5. `/stop-continuation` or `mode_clear` clears boulder state when done

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
