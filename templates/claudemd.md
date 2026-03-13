--- omca-setup
plugin: oh-my-claudeagent
version: 1.0.0
author: UtsavBalar1231
---

# oh-my-claudeagent — Multi-Agent Orchestration

You are running with oh-my-claudeagent, a multi-agent orchestration plugin.
Coordinate specialist agents, tools, and skills for accurate, efficient work.

## How It Works

The plugin loads via the Claude Code marketplace (or `--plugin-dir` for development). On session start:

1. **Hooks activate** - `session-init.sh` initializes session state in `.omca/state/` and injects this runtime spec.
2. **Keyword detection** - `keyword-detector.sh` listens for trigger phrases on every user prompt (for example `ralph`, `ultrawork`, or `handoff`) and emits `[... DETECTED]` additional context when a mode should activate.
3. **Observability** - `instructions-loaded-audit.sh` records `InstructionsLoaded` events in `.omca/logs/instructions-loaded.jsonl` without changing runtime behavior.
4. **Context injection and lifecycle tracking** - hooks inject nearby `AGENTS.md`/`README.md` content on reads, recover from edit/delegation errors, audit edits, and track spawned subagents.
5. **Agent orchestration** - the default agent (`sisyphus`) delegates to specialists via `Agent(subagent_type="oh-my-claudeagent:NAME")`.

## Source of Truth

The canonical feature lists are ONLY what exists on disk in this repository:

| Asset | Canonical Location | Rule |
|-------|-------------------|------|
| Agents | `agents/*.md` | YAML frontmatter defines model, tools, role |
| Skills | `skills/*/SKILL.md` | Directory without `SKILL.md` = nonexistent |
| Scripts | `scripts/*.sh` | `hooks/hooks.json` registers 24 hook commands; `start-ast-grep-server.sh`, `validate-plugin.sh`, and the two worktree helpers remain utilities |
| Hooks | `hooks/hooks.json` | Single registry mapping events to scripts |
| MCP Servers | `.mcp.json` + `servers/` | Server config and implementation |

Do NOT read `~/.claude/CLAUDE.md` or any installed plugin content to determine what features exist. That file contains injected orchestration rules that may not reflect on-disk reality. Always verify against the files listed above.

## Delegation

Delegate for: multi-file changes, refactors, debugging, reviews, planning, research.
Work directly for: trivial operations, small clarifications, single-command ops.

## Agent Catalog

Use `Agent(subagent_type="oh-my-claudeagent:NAME")` for delegation.

| Agent | Model | When to use |
|-------|-------|-------------|
| sisyphus | opus | Master orchestrator — delegates, never works alone |
| atlas | opus | Todo list execution — completes ALL tasks via delegation |
| prometheus | opus | Interview-driven strategic planning |
| metis | opus | Pre-planning analysis — catches gaps |
| momus | opus | Plan review and critique |
| oracle | opus | Architecture advice (read-only) |
| sisyphus-junior | sonnet | Focused implementation work |
| explore | sonnet | Codebase search and discovery |
| librarian | sonnet | External docs and SDK research |
| hephaestus | sonnet | Build/toolchain/type error fixing |
| multimodal-looker | sonnet | Image, PDF, diagram analysis |

Model override: use `Agent(subagent_type="oh-my-claudeagent:NAME", model="haiku|opus")` for cost/quality tuning.

## Skills

Invoke via `/oh-my-claudeagent:NAME` or keyword triggers.

| Skill | Triggers | Purpose |
|-------|----------|---------|
| ralph | "ralph", "don't stop" | Persistence loop until verified complete |
| ultrawork | "ulw", "ultrawork" | Maximum parallel execution |
| omca-setup | "setup omca" | Configure ~/.claude/ for this plugin |
| handoff | "handoff" | Session continuity summary |
| cancel-ralph | "cancel ralph" | Cancel active ralph persistence loop |
| stop-continuation | "stop continuation" | Stop all continuation mechanisms |
| refactor | "refactor" | Codebase-aware refactoring |
| start-work | "start work" | Execute from a generated plan |
| git-master | git operations | Atomic commits, rebase, bisect |
| frontend-ui-ux | UI/design work | Designer-quality frontend patterns |
| init-deep | "/init-deep" | Generate hierarchical AGENTS.md |
| dev-browser | browser tasks | Browser with persistent state |
| playwright | browser automation | Playwright MCP integration |

## Capability Provenance

Classify capability claims before relying on them:

| Classification | What it covers here | Ownership boundary |
|---------------|---------------------|--------------------|
| Bundled by this plugin | `agents/*.md`, `skills/*/SKILL.md`, hook registrations in `hooks/hooks.json`, repo hook/runtime scripts in `scripts/`, plugin-managed `.omca/` bootstrap state, and the bundled `ast-grep` MCP server/tools | Verify against on-disk files in this repo; do not expand from memory |
| Claude-native | `Agent(...)`, slash-command execution, hook/event semantics, todo/task primitives, managed instruction loading, and any LSP surfaces Claude Code itself exposes | Claude Code owns these primitives; this repo only orchestrates around them |
| Optional external/host-provided | Host binaries such as `jq`, `python3`, `ast-grep`/`sg`; Playwright/browser runtimes; any `.lsp.json`, language-server packaging, or extra notepad/project-memory/state/Python helper tools from other plugins or local setup | This repo does not bundle those runtimes, configs, or extra tool surfaces |

If your environment exposes `lsp_*`, notepad/project-memory/state helpers, or a Python REPL, treat them as Claude-native or separately installed capabilities. This plugin does not ship `.lsp.json` or any extra LSP/notepad/project-memory/state/Python tool bundle.

## Bundled MCP Tools

This repo bundles one MCP server, `ast-grep`, via `.mcp.json`. Its shipped tools are:

- `ast_grep_search`
- `ast_grep_replace`
- `find_code_by_rule`
- `test_match_code_rule`
- `dump_syntax_tree`

## Hook System

### How Hooks Work

1. Claude Code emits an **event** (e.g., `PostToolUse`)
2. `hooks/hooks.json` maps events to scripts, optionally filtered by a **matcher** (tool name pattern)
3. The script receives a JSON payload on **stdin**, processes it, and may return JSON on **stdout**.
4. Hook responses are wrapped under `hookSpecificOutput`, most often with `additionalContext`, `permissionDecision`, or `decision` fields.

### Hook Events

| Event | Scripts | Matchers |
|-------|---------|----------|
| SessionStart | `session-init.sh`, `post-compact-inject.sh` | (none), `compact` |
| InstructionsLoaded | `instructions-loaded-audit.sh` | (none) |
| UserPromptSubmit | `keyword-detector.sh` | (none) |
| SubagentStart | `subagent-start.sh` | (none) |
| PreToolUse | `track-subagent-spawn.sh`, `write-guard.sh` | `Task\|Agent`, `Write` |
| PermissionRequest | `permission-filter.sh` | `Bash` |
| PostToolUse | `post-edit.sh`, `comment-checker.sh`, `context-injector.sh`, `agent-usage-reminder.sh`, `empty-task-response.sh` | `Write\|Edit`, `Write\|Edit`, `Read`, `Grep\|Glob\|WebFetch\|WebSearch`, `Task\|Agent` |
| PostToolUseFailure | `edit-error-recovery.sh`, `delegate-retry.sh`, `json-error-recovery.sh` | `Edit`, `Task\|Agent`, (catch-all) |
| Stop | `ralph-persistence.sh` | (none) |
| SubagentStop | `subagent-complete.sh` | (none) |
| PreCompact | `pre-compact.sh` | (none) |
| SessionEnd | `session-cleanup.sh` | (none) |
| Notification | `notify.sh` | `idle_prompt\|permission_prompt` |
| TaskCompleted | `task-completed-verify.sh` | (none) |
| TeammateIdle | `teammate-idle-guard.sh` | (none) |
| ConfigChange | `config-change-audit.sh` | (none) |

Claude Code native git worktree behavior is authoritative; `worktree-setup.sh` and `worktree-cleanup.sh` remain unregistered utilities rather than active hook overrides.

Hooks inject context via `<system-reminder>` tags:
- `hook success: Success` - proceed normally
- `hook additional context: ...` - read it, relevant to your task
- `[NAME DETECTED]` - keyword trigger activated a skill or mode

## State Management

Plugin-managed runtime state lives in `.omca/` (gitignored). Core files are created automatically; mode-specific files appear only when those workflows run:

```
.omca/
  state/
    session.json               # Current session metadata
    agent-usage.json           # Direct-tool usage and delegation tracking
    injected-context-dirs.json # Context injection cache
    subagents.json             # Active/completed subagent tracking
    compaction-context.md      # Single-use restore payload for compact starts
    verification-evidence.json # Fresh verification evidence for TaskCompleted
    ralph-state.json           # Ralph persistence state, when active
    ultrawork-state.json       # Ultrawork state, when active
    boulder.json               # Active plan/continuation state, when present
    team-state.json            # Team coordination state, when present
    worktrees/                 # Worktree tracking metadata for helper utilities
  plans/                       # Plan artifacts used by planning/execution skills
  logs/
    sessions.jsonl            # Session lifecycle audit
    edits.jsonl               # File edit audit trail
    instructions-loaded.jsonl # InstructionsLoaded observability log
    subagents.jsonl           # Structured subagent spawn/complete events
    errors.jsonl              # Edit-failure recovery log
    agent-spawns.log          # Human-readable spawned-agent log
    config-changes.log        # ConfigChange audit trail
```

## Rules

- Verify before claiming completion — run tests, check output
- Max 5 parallel agents (never 6+)
- Delegate complex work to specialists; work directly only for trivial tasks
- Use `Agent(subagent_type="oh-my-claudeagent:NAME")` for delegation
- Do NOT use sequential agents when parallel is possible — use parallel `Agent()` calls in a single response
- Do NOT claim completion without evidence — verify with build/test commands
- Do NOT read `~/.claude/CLAUDE.md` for feature lists — read on-disk files in this repo
- Do NOT use `set -euo pipefail` in hook scripts — exit 0 with graceful degradation
- Do NOT create skill directories without `SKILL.md` — delete the directory or add `SKILL.md`
- Do NOT write state to `~/.claude/` — use `.omca/state/`
- Do NOT use custom swarm scripts — use Claude Code native Teams API

## Setup

Run `/oh-my-claudeagent:omca-setup` to configure or update.
Run `/oh-my-claudeagent:omca-setup --uninstall` to remove.

--- /omca-setup ---
