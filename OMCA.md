# oh-my-claudeagent — Complete Guide

This guide covers everything you need to use oh-my-claudeagent effectively: installation,
every agent and skill, common workflows, MCP tools, runtime state, and how it all fits
together under the hood.

For quick install, see `README.md`. For contributor internals (hooks, adding components,
ADRs), see `CLAUDE.md` (auto-generated locally, not tracked in git).

---

## What Is This

### The Problem

Claude Code runs as a single thread. When a task requires simultaneous research plus
implementation, or when ten files need fixing at once, the default session becomes a
bottleneck. There is no built-in way to delegate, no specialist agents, and no persistence
guarantee that a long task will run to completion.

### The Solution

oh-my-claudeagent adds a multi-agent layer on top of Claude Code:

- **12 specialist agents** with distinct roles and model tiers (opus, sonnet, haiku)
- **20 skills** invokable via slash commands or keyword triggers
- **28 hook commands** wired to 18 event types for session persistence, context injection,
  auto-approval, and error recovery (29 scripts on disk: 28 hook + `validate-plugin.sh` utility)
- **3 MCP servers** for structural code search, state tracking, public code search, and
  library documentation

### Philosophy

Delegate to specialists, verify with evidence, ship with confidence.

The core loop is: explore first, then plan, then execute in parallel, then verify. Every
agent either delegates work or implements it — never both. Every completion claim requires
evidence.

---

## Core Concepts

### Agents

Agents are markdown files in `agents/*.md`. Each has a YAML frontmatter block defining
its name, model, tools, and behavior. Claude Code loads them as subagent types addressable
via `Agent(subagent_type="oh-my-claudeagent:NAME")`.

**Model tiers:**

| Tier | Default for | Cost | Use for |
|------|-------------|------|---------|
| opus | Orchestrators, planners, reviewers | Expensive | Complex reasoning, architecture, multi-step coordination |
| sonnet | Executors, searchers, fixers | Moderate | Standard implementation, search, builds |
| haiku | (override only) | Cheap | Quick lookups, simple transforms |

You can override any agent's model on the call site:
```
Agent(subagent_type="oh-my-claudeagent:explore", model="haiku")
Agent(subagent_type="oh-my-claudeagent:sisyphus-junior", model="opus")
```

**Delegation chain:**

The nesting constraint is hard: subagents at depth 1 cannot spawn further subagents —
the `Agent` tool is stripped by the platform at that depth.

```
main session
  └── orchestrator (depth 0, via context:fork skill)
        └── worker (depth 1, via Agent() — terminal)
```

Orchestrators (atlas, sisyphus) MUST be invoked via their `context: fork` skills
(`/oh-my-claudeagent:atlas`, `/oh-my-claudeagent:sisyphus-orchestrate`) — not via
`Agent()`. Fork runs them at depth 0 with full tool access.

### Skills

Skills are directories in `skills/*/SKILL.md`. A directory without a `SKILL.md` is
ignored. Skills are invoked via `/oh-my-claudeagent:NAME` in any Claude Code session.

Two execution modes:

- **Direct skills** — the skill SKILL.md IS the agent prompt. Runs in the current session.
- **`context: fork` skills** — forks into a fresh agent context. Used for orchestrators
  (atlas, sisyphus) and planners (prometheus) to give them the `Agent` tool at depth 0.

Keywords typed in any prompt auto-activate certain skills without a slash command. The
`keyword-detector.sh` hook on `UserPromptSubmit` pattern-matches the lowercase prompt and
injects `[MODE DETECTED]` context to trigger the corresponding skill.

### Hooks

Hooks are bash scripts in `scripts/*.sh`, registered in `hooks/hooks.json`. They run on
Claude Code lifecycle events: session start/end, tool use, permission requests, agent
lifecycle, and more.

The hook system provides:
- Context injection (AGENTS.md, rules, notepad directives)
- Persistence blocking (ralph mode prevents Stop events)
- Permission auto-approval (package managers, MCP tools, .omca/ access)
- Error recovery suggestions (re-read after failed Edit, escalate after failed Agent)
- Compaction survival (state saved pre-compact, re-injected post-compact)
- Verification gating (TaskCompleted blocked without fresh evidence)

Hooks communicate via stdout JSON. The most common patterns:

```json
{"hookSpecificOutput": {"hookEventName": "EVENT", "additionalContext": "..."}}
```
```json
{"hookSpecificOutput": {"hookEventName": "Stop", "decision": {"behavior": "block"}}}
```

### MCP Tools

Three MCP servers are bundled via `.mcp.json` and launched by Claude Code:

- **omca** — Unified local server: structural code search (ast-grep), boulder (plan tracking), evidence (verification records), notepads, and agent catalog tools
- **grep** — HTTP-based public GitHub code search
- **context7** — HTTP-based library documentation lookup

MCP tools are inherited by agents that do not declare a `tools:` allowlist in frontmatter. Use `disallowedTools:` instead of `tools:` to preserve MCP tool inheritance.

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

### omca-setup Walkthrough

After installing, run `/oh-my-claudeagent:omca-setup`. This skill:

1. **Phase 1** — Checks dependencies: `jq` (required for hooks), `uv` (required for MCP
   servers), `python3` 3.10+ (required), `ast-grep` or `sg` CLI (optional, for structural
   search)
2. **Phase 2** — Reads `templates/claudemd.md` and stamps the current version and install
   timestamp
3. **Phase 3** — Backs up and reads existing `~/.claude/CLAUDE.md`, removes any old plugin
   block
4. **Phase 4** — Writes the new block to `~/.claude/CLAUDE.md`
5. **Phase 5** — Inspects plugin registration state, prints install/enterprise guidance
6. **Phase 5.5** — Offers to apply permission rules to `~/.claude/settings.json`:
   `.omca/**` access, MCP tool allow-lists, `Bash(jq *)`, `Bash(uv run *)`,
   `teammateMode: "auto"`
7. **Phase 5.6** — Offers to configure the statusline (daemon or direct mode)
8. **Phase 6** — Prints the health report

Run `/oh-my-claudeagent:omca-setup --check` for a read-only health check.
Run `/oh-my-claudeagent:omca-setup --uninstall` to remove the plugin block.

### Inline Settings Install

As an alternative to the marketplace, declare the plugin directly in `settings.json`
using `source: 'settings'`. This avoids a separate marketplace registration step:

```json
{
  "plugins": {
    "oh-my-claudeagent": {
      "source": "settings",
      "repo": "UtsavBalar1231/oh-my-claudeagent"
    }
  }
}
```

This method is useful for locked-down environments where marketplace commands are
restricted but settings file edits are allowed.

### Team Setup

Add to your project's `.claude/settings.json` so all team members get the plugin
automatically:

```json
{
  "extraKnownMarketplaces": {
    "omca": {
      "source": {
        "source": "github",
        "repo": "UtsavBalar1231/oh-my-claudeagent"
      }
    }
  },
  "enabledPlugins": {
    "oh-my-claudeagent@omca": true
  }
}
```

### Update and Uninstall

```bash
/plugin marketplace update omca
/plugin uninstall oh-my-claudeagent@omca
```

### First Session Walkthrough

1. Install and run omca-setup.
2. Start a new session: `claude`
3. Try the planning pipeline: type "create plan for adding user authentication"
   — Prometheus opens an interview, gathers requirements, generates a work plan.
4. After plan review: run `/oh-my-claudeagent:start-work`
   — Atlas picks up the plan, delegates tasks to sisyphus-junior in parallel.
5. For guaranteed completion: type "ralph don't stop"
   — Ralph mode activates; the session blocks on Stop until all tasks are verified.
6. For maximum speed: type "ultrawork"
   — Ultrawork batches independent tasks across up to 5 concurrent agents.
7. When context is long: type "handoff"
   — A structured session summary is produced for pasting into a new session.

---

## Agent Reference

### Orchestrators

#### sisyphus

| | |
|-|-|
| Model | opus |
| Invocation | `/oh-my-claudeagent:sisyphus-orchestrate` or type "run sisyphus" |
| Max turns | 30 |

Master orchestrator. Classifies every incoming request (trivial, explicit, exploratory,
open-ended, ambiguous), assesses codebase maturity, and routes work to specialists. It
never implements directly unless the change is a single-file edit under 20 lines with no
test impact. All other work is delegated.

Phase 0 is an intent gate that runs on every message: classify the request, verbalize the
routing decision, check for ambiguity, then delegate or act. Parallel explore agents run
in the background while sisyphus continues with non-overlapping work.

**When to use:** Open-ended, adaptive tasks where the work plan emerges during execution.
Use `/oh-my-claudeagent:sisyphus-orchestrate` skill (not `Agent()`).

**Escalates to:** explore (research), oracle (architecture), hephaestus (build fixes),
metis (gap analysis before planning), prometheus (structured planning).

#### atlas

| | |
|-|-|
| Model | opus |
| Invocation | `/oh-my-claudeagent:atlas [plan path]` or type "run atlas" |
| Max turns | 30 |

Todo-list orchestrator. Reads a work plan (`.omca/plans/*.md` checkboxed tasks), analyzes
parallelizability, and drives execution by delegating one task per sisyphus-junior call.
Auto-continues without asking the user between tasks. Verifies every delegation with a
project-level build, typecheck, and test run. Marks checkboxes in the plan file as tasks
complete.

After ALL implementation tasks complete, atlas spawns a Final Verification Wave — four
review agents in parallel (oracle for plan compliance, sisyphus-junior for code quality,
manual QA, and scope fidelity) — and waits for user sign-off before reporting completion.

**When to use:** Executing a structured plan from prometheus. Use `/oh-my-claudeagent:atlas`
(not `Agent()`).

**Escalates to:** sisyphus-junior for all implementation, oracle for compliance review,
metis for re-analysis when multiple tasks fail.

---

### Planning and Review

#### prometheus

| | |
|-|-|
| Model | opus |
| Invocation | `/oh-my-claudeagent:prometheus-plan` or type "create plan" |
| Max turns | 15 |

Strategic planning consultant. Conducts a requirements interview (the clearance checklist
has 9 items: objective, scope, success criteria, dependencies, risks, technical approach,
test strategy, ambiguities, and blocking questions), then generates a structured work plan
to `.omca/plans/{name}.md`.

Before generating, prometheus mandatorily consults metis for gap analysis. After
generating, it mandatorily submits to momus for review. Up to 3 revision iterations before
escalating to the user.

Plans follow a specific structure: TL;DR, context, work objectives with Must Have / Must
NOT Have sections, verification strategy, checkboxed TODO items each with QA scenarios,
and a Final Verification Wave specification for atlas.

**When to use:** Starting any non-trivial feature, refactor, or project. Type "create plan"
or use the skill.

**Escalates to:** metis (gap analysis), momus (plan review), explore/librarian (research
during interview).

#### metis

| | |
|-|-|
| Model | opus |
| Invocation | `/oh-my-claudeagent:metis` or type "run metis" |
| Max turns | 10 |

Pre-planning analyst. Classifies request intent (refactoring, build from scratch,
mid-sized task, collaborative, architecture, research), explores the codebase for relevant
patterns, identifies hidden requirements and scope inflation risks, and produces structured
directives for prometheus. Also flags AI-slop patterns: generic naming, premature
abstraction, over-validation, documentation bloat.

Invoked automatically by prometheus before plan generation. Can also be invoked standalone
for gap analysis.

**When to use:** Before planning, or when requirements are ambiguous. Called automatically
by prometheus and atlas (when multiple tasks fail).

**Escalates to:** explore (codebase research), oracle (architecture questions).

#### momus

| | |
|-|-|
| Model | opus |
| Invocation | `Agent(subagent_type="oh-my-claudeagent:momus", prompt="path/to/plan.md")` |
| Max turns | 10 |

Rigorous plan reviewer. Evaluates work plans against five criteria: clarity of work
content (reference sources), verification and acceptance criteria (concrete and
measurable), context completeness (90% confidence threshold), QA scenario executability
(tool + steps + expected result), and big-picture understanding (why/what/how). Returns
OKAY or REJECT with at most three critical issues.

Approval bias: a plan that is 80% clear is good enough. Momus evaluates documentation
quality within the chosen approach — it does not redesign.

**When to use:** Called automatically by prometheus after plan generation. Not meant for
manual invocation on inline plans; file path only.

#### oracle

| | |
|-|-|
| Model | opus |
| Invocation | `Agent(subagent_type="oh-my-claudeagent:oracle", prompt="...")` |
| Max turns | 3 (read-only) |

Architecture advisor. Read-only (no Write, no Edit). Analyzes codebases, formulates
concrete recommendations with effort estimates (Quick/Short/Medium/Large), presents a
single primary recommendation, and surfaces hidden risks. Dense output: bottom line in 2-3
sentences, action plan in 7 steps max.

**When to use:** After 2+ failed fix attempts, complex architecture decisions,
multi-system tradeoffs, security or performance concerns, and as the final verifier in
atlas's verification wave.

**Never use for:** Simple file operations, first fix attempts, trivial decisions.

---

### Search and Research

#### explore

| | |
|-|-|
| Model | sonnet |
| Invocation | `Agent(subagent_type="oh-my-claudeagent:explore", run_in_background=true, prompt="...")` |
| Max turns | 5 (read-only) |

Codebase search specialist. Finds files, patterns, and implementations. Always run in the
background (`run_in_background=true`). Returns structured output: FILES list with
absolute paths, ANSWER addressing the actual need, and NEXT STEPS.

Uses ast_search for structural patterns, Grep for text, Glob for filename patterns,
Bash for git history. Floods with parallel tool calls.

**When to use:** "Where is X?", "Which file has Y?", "Find the code that does Z". Fire
multiple in parallel for broad searches.

**Note:** Cannot use Read for files outside the project root when spawned in plan mode.
Workaround: use Bash with `cat` for external files.

#### librarian

| | |
|-|-|
| Model | sonnet |
| Invocation | `Agent(subagent_type="oh-my-claudeagent:librarian", run_in_background=true, prompt="...")` |
| Max turns | 5 (read-only) |

External documentation and open-source code researcher. Uses context7 for official library
docs, clones repos to a temp directory for source investigation, and searches GitHub for
real-world usage examples. Every factual claim must include a GitHub permalink with commit
SHA.

Classifies requests: TYPE A (conceptual — docs + websearch), TYPE B (implementation —
clone + read + blame), TYPE C (context/history — issues + PRs + git log), TYPE D
(comprehensive — all tools).

**When to use:** "How do I use [library]?", "What's the best practice for [framework]?",
"Find examples of [package] usage". Use explore for local codebase questions.

#### socrates

| | |
|-|-|
| Model | opus |
| Invocation | `Agent(subagent_type="oh-my-claudeagent:socrates", prompt="...")` |
| Max turns | 20 |

Deep research interview consultant. Investigates complex questions through iterative
dialogue: launches parallel explore/librarian agents, asks targeted follow-up questions,
researches based on answers, and synthesizes comprehensive findings. Each claim tagged with
confidence level (HIGH/MEDIUM/LOW). Must cite at least two independent sources before
concluding on a factual claim.

Produces knowledge and understanding, not work plans. For work plans, use prometheus.

**When to use:** Complex questions requiring investigation, iterative dialogue, and
synthesis — not for codebase search (use explore) or architecture advice (use oracle).

---

### Execution

#### sisyphus-junior

| | |
|-|-|
| Model | sonnet |
| Invocation | `Agent(subagent_type="oh-my-claudeagent:sisyphus-junior", prompt="...")` |
| Max turns | 20 |

Focused task executor. Implements directly — never delegates implementation work. Can
spawn explore/librarian for research. Creates a task list for multi-step work, marks each
task in_progress before starting and completed immediately after. Requires fresh
verification evidence before claiming completion.

Follows the structured completion format: TASK, STATUS, CHANGES, EVIDENCE, NOTES. For
escalation, reports to the parent agent with: BLOCKED, REASON, ATTEMPTED, RECOMMEND.

**When to use:** All implementation work delegated from atlas or sisyphus. One atomic task
per delegation.

**Escalates to:** explore (research), oracle (architecture needed), hephaestus (build
failure). Never attempts architectural changes itself.

#### hephaestus

| | |
|-|-|
| Model | sonnet |
| Invocation | `/oh-my-claudeagent:hephaestus` or type "fix build" |
| Max turns | 15 |

Build and toolchain fixer. Workflow: reproduce the failure, diagnose root cause, make
minimal fix, verify. Repeat until exit code 0. Strict minimal-diff policy — never refactor
while fixing, never use `as any` or `@ts-ignore`, never make architectural changes.

**When to use:** Build failures, type errors, dependency problems, toolchain issues. Use
the skill for interactive invocation or `Agent()` for delegation.

**Escalates to:** oracle (architectural changes needed), sisyphus (cross-module impact).
Stops and reports after 5+ failed fix attempts.

#### multimodal-looker

| | |
|-|-|
| Model | sonnet |
| Invocation | `Agent(subagent_type="oh-my-claudeagent:multimodal-looker", prompt="file path + goal")` |
| Max turns | 3 (read-only) |

Multimodal analyst for images, PDFs, and diagrams. Reads and interprets visual content
that cannot be parsed as plain text. Returns structured output: TYPE, CONFIDENCE,
EXTRACTED (the requested information), STRUCTURE (layout/components/hierarchy), and
LIMITATIONS (what could not be extracted).

**When to use:** Screenshots, UI mockups, architecture diagrams, PDFs with mixed
text/visual content. Not for source code or plain text files.

**Note:** Cannot use Bash (read-only tools only). Cannot access external files outside
the project root in plan mode.

---

## Skill Reference

### Persistence

| Skill | Invoke | Keyword trigger |
|-------|--------|----------------|
| ralph | `/oh-my-claudeagent:ralph` | "ralph", "don't stop", "must complete" |
| ultrawork | `/oh-my-claudeagent:ultrawork` | "ulw", "ultrawork" |
| ulw-loop | `/oh-my-claudeagent:ulw-loop` | "ulw-loop", "ultrawork loop" |

**ralph** — Persistence mode. Activates a loop that blocks the Stop event until all tasks
are verified complete. Tasks are registered with TaskCreate, errors become new fix tasks
(never a reason to stop), and oracle must approve before the loop exits. State stored in
`.omca/state/ralph-state.json`.

**ultrawork** — Maximum parallel execution. Groups independent tasks into batches of up to
5 concurrent agents, launches each batch simultaneously, collects results, and continues.
Requires 100% certainty before any implementation: understand the request, explore the
codebase, resolve all ambiguity. Up to 5 agents simultaneously.

**ulw-loop** — Combines ralph persistence with ultrawork parallelism AND oracle verification.
The session does not exit until all tasks are complete AND oracle returns APPROVE. Strictest
completion guarantee of the three.

---

### Planning Pipeline

| Skill | Invoke | Keyword trigger |
|-------|--------|----------------|
| prometheus-plan | `/oh-my-claudeagent:prometheus-plan` | "create plan" |
| metis | `/oh-my-claudeagent:metis` | "run metis" |
| atlas | `/oh-my-claudeagent:atlas [plan path]` | "run atlas" |
| start-work | `/oh-my-claudeagent:start-work` | (none) |
| sisyphus-orchestrate | `/oh-my-claudeagent:sisyphus-orchestrate` | "run sisyphus" |

**prometheus-plan** — Forks the prometheus agent. Conducts a requirements interview, runs
the clearance checklist, consults metis, generates the plan to `.omca/plans/`, runs momus
review, and hands off with instructions to use `/start-work`.

**metis** — Forks the metis agent. Analyzes a request before planning: classifies intent,
explores codebase, identifies risks and gaps, produces directives for prometheus.

**atlas** — Forks the atlas agent. Executes a plan file (or resumes active boulder state).
Use when you already have a structured prometheus-generated plan.

**start-work** — Forks atlas but adds setup steps first: finds the active plan (via
boulder state, `.omca/plans/`, or `~/.claude/plans/`), creates or updates
`.omca/state/boulder.json`, optionally configures a git worktree, then executes via the
atlas workflow.

**sisyphus-orchestrate** — Forks the sisyphus agent. Use for open-ended, adaptive work
where the plan emerges during execution. Note: sisyphus does not set `permissionMode`, so
it inherits the session's mode. If in plan mode, exit plan mode first or use `/start-work`.

---

### Fixing and Development

| Skill | Invoke | Keyword trigger |
|-------|--------|----------------|
| hephaestus | `/oh-my-claudeagent:hephaestus` | "fix build", "build broken" |
| refactor | `/oh-my-claudeagent:refactor [target]` | (none) |
| git-master | `/oh-my-claudeagent:git-master` | "commit", "rebase" |

**hephaestus** — Forks the hephaestus agent. Discovers the current build failure
automatically if none is specified. Runs the fix loop and records build evidence.

**refactor** — Codebase-aware refactoring. Phases: intent gate, parallel codebase
analysis (5 explore agents), codemap and impact zone mapping, test coverage assessment,
prometheus plan generation, step-by-step execution with ast-grep and typecheck after each
step, final verification wave. Blocks on low test coverage. Supports `--scope` and
`--strategy` flags.

**git-master** — Three-mode Git expert: COMMIT (atomic commits with style detection from
git log, mandatory multiple commits for 3+ files), REBASE (history cleanup, squash,
autosquash), HISTORY_SEARCH (blame, bisect, log -S, log -G). All commands prefixed with
`GIT_EDITOR=: EDITOR=:` to prevent interactive hang.

---

### Browser

| Skill | Invoke | Keyword trigger |
|-------|--------|----------------|
| playwright | `/oh-my-claudeagent:playwright` | (none) |
| dev-browser | `/oh-my-claudeagent:dev-browser` | "go to [url]", "click on", "take a screenshot" |

**playwright** — Browser automation via Playwright MCP server. Requires adding the
Playwright MCP server to `.mcp.json`. Uses `browser_snapshot` (accessibility tree) for
structured interaction, `browser_screenshot` for visual evidence. Falls back to
`/dev-browser` if Playwright MCP is not configured.

**dev-browser** — Browser automation with persistent page state via a Node.js relay
server. Writes small focused scripts using heredocs, each doing one thing. Supports ARIA
snapshot discovery (`getAISnapshot`, `selectSnapshotRef`) for unknown page layouts.
Extension mode connects to the user's existing Chrome browser.

---

### Session Management

| Skill | Invoke | Keyword trigger |
|-------|--------|----------------|
| handoff | `/oh-my-claudeagent:handoff` | "handoff", "context is getting long" |
| cancel-ralph | `/oh-my-claudeagent:cancel-ralph` | "cancel ralph" |
| stop-continuation | `/oh-my-claudeagent:stop-continuation` | "stop continuation", "pause automation" |

**handoff** — Gathers context from git log, git status, TaskList, boulder state, and
notepad sections, then produces a structured HANDOFF CONTEXT block (user requests verbatim,
goal, work completed, current state, pending tasks, key files, decisions, constraints) for
pasting into a new session.

**cancel-ralph** — Removes `.omca/state/ralph-state.json`, canceling the ralph loop
without affecting other state. Use when you want to stop persistence while keeping the
active plan.

**stop-continuation** — Removes both `.omca/state/ralph-state.json` and
`.omca/state/boulder.json`. Full reset: no more ralph loop, no active plan. Use for a
clean slate.

---

### Setup and Discovery

| Skill | Invoke | Keyword trigger |
|-------|--------|----------------|
| omca-setup | `/oh-my-claudeagent:omca-setup` | "setup omca" |
| init-deep | `/oh-my-claudeagent:init-deep [path]` | (none) |
| frontend-ui-ux | `/oh-my-claudeagent:frontend-ui-ux` | (none) |
| github-triage | `/oh-my-claudeagent:github-triage [repo]` | "triage", "triage issues", "triage PRs" |

**omca-setup** — Full plugin configuration: dependency check, CLAUDE.md block injection,
permission rules, statusline setup. See the "omca-setup Walkthrough" section above.

**init-deep** — Generates hierarchical AGENTS.md files across the codebase. Scores
directories by file count, code concentration, module boundaries, and symbol density, then
generates root + subdirectory AGENTS.md files in parallel. Supports `--create-new` and
`--max-depth` flags. Reads existing AGENTS.md files before regenerating to preserve
context.

**frontend-ui-ux** — Designer-turned-developer mode. Commits to a bold aesthetic
direction (brutalist, maximalist, editorial, etc.) before implementing. Avoids generic
fonts (Inter, Roboto, Arial) and cliched color schemes. Produces production-grade UI with
distinctive typography, cohesive palettes, and meaningful animation.

**github-triage** — Read-only GitHub issue and PR analyzer. Fetches all open items,
classifies each (ISSUE_QUESTION, ISSUE_BUG, ISSUE_FEATURE, ISSUE_OTHER, PR_BUGFIX,
PR_OTHER), and spawns one background sisyphus-junior per item in parallel batches of 5.
Each subagent writes a report to `/tmp/github-triage-{datetime}/`. Zero-action policy:
never merges, closes, or edits GitHub items.

---

## Common Workflows

### Planning Pipeline

The full planning pipeline: prometheus interviews, metis catches gaps, momus reviews,
atlas executes.

```
1. Type "create plan for [your task]"
   -> Prometheus opens interview mode
   -> Prometheus consults metis (mandatory pre-generation)
   -> Prometheus generates plan to .omca/plans/name.md
   -> Prometheus submits to momus (mandatory review)
   -> Momus returns OKAY or REJECT (up to 3 iterations)
   -> Prometheus presents plan and handoff instructions

2. Type "/oh-my-claudeagent:start-work"
   -> Finds active plan (boulder state or .omca/plans/)
   -> Creates/updates .omca/state/boulder.json
   -> Optionally sets up git worktree
   -> Forks atlas for execution

3. Atlas executes:
   -> Analyzes parallelizability of tasks
   -> Delegates each task to sisyphus-junior (one per agent call)
   -> Verifies with build/typecheck/tests after each delegation
   -> Marks checkboxes in plan file
   -> Final Verification Wave (oracle + 3x sisyphus-junior)
   -> Waits for user sign-off

4. Resume with "/oh-my-claudeagent:start-work" after any interruption
   -> Boulder state resumes from last completed task
```

### Ralph Persistence

Ralph mode prevents the session from ending until work is verified complete.

```
1. Type "ralph don't stop" or "ralph: [task description]"
   -> Keyword detector injects [RALPH MODE DETECTED]
   -> Ralph skill activates, writes .omca/state/ralph-state.json
   -> ralph-persistence.sh (Stop hook) blocks Stop events

2. Session loop:
   -> Execute tasks with delegation
   -> On error: create fix task, continue (never stop on error)
   -> On 3 consecutive failures on same task: escalate to oracle
   -> After all tasks: run oracle verification
   -> If oracle rejects: create fix tasks, loop again
   -> If oracle approves: deactivate ralph, allow stop

3. Cancel: type "cancel ralph" or run /oh-my-claudeagent:cancel-ralph
```

### Ultrawork Parallel Execution

```
1. Type "ultrawork" or "ulw [task]"
   -> Keyword detector injects [ULTRAWORK MODE DETECTED]
   -> Ultrawork skill activates

2. Analyze tasks for parallelizability:
   -> Independent tasks (different files, no data deps): batch together
   -> Dependent tasks: sequential batches

3. Execute batches:
   -> Each batch: invoke up to 5 Agent() calls in one response
   -> Wait for batch to complete
   -> Collect results (including failures)
   -> Create fix tasks for failures, continue with next batch

4. Final verification:
   -> Aggregate all results
   -> Run integration tests
   -> Record evidence via evidence_log
```

### Session Handoff

When context is long and session quality is degrading:

```
1. Type "handoff" or "context is getting long"
   -> Handoff skill activates
   -> Gathers: git log/status, TaskList, boulder state, notepad data
   -> Produces HANDOFF CONTEXT block

2. Copy the HANDOFF CONTEXT output

3. Start a new session: claude

4. Paste HANDOFF CONTEXT as your first message, then add:
   "Continue from the handoff context above. [Your next task]"
```

---

## MCP Tools

Three MCP servers are wired in `.mcp.json` and launched by Claude Code when the plugin
is loaded. MCP tools are inherited by agents that do not declare a `tools:` allowlist in
frontmatter. Use `disallowedTools:` instead of `tools:` to preserve MCP tool inheritance.

### omca (local Python FastMCP server)

Unified server for structural code search, plan tracking, verification evidence, notepads,
and agent catalog. Launched via `uv run --project servers` from the servers directory.
Implements all tool groups below.

**AST tools** — Structural code search and transformation using the `sg` (ast-grep) CLI:

| Tool | Purpose |
|------|---------|
| `ast_search` | Find code patterns by structure (function signatures, class shapes, import patterns) |
| `ast_replace` | Structural find-and-replace; use `dry_run=true` to preview before applying |
| `ast_find_rule` | Advanced structural queries with YAML combinators |
| `ast_test_rule` | Test a rule pattern against a code snippet |
| `ast_dump_tree` | Dump the AST of a code snippet for rule development |

**When to use AST tools:** Structural patterns. Use Grep for text/string search, ast_search
for code structure (e.g., "all functions with a specific parameter type").

**State tools** — Plugin state management: boulder (plan tracking), evidence (verification), notepads
(inter-agent learning).

**Boulder tools** — Track the active work plan across sessions and compactions:

| Tool | Purpose |
|------|---------|
| `boulder_write` | Register active plan: `boulder_write(active_plan, plan_name, session_id)` |
| `mode_read` | Read unified state dashboard (active modes: ralph, ultrawork, boulder, evidence) |
| `mode_clear` | Deactivate modes — defaults to "all" (ralph + ultrawork + boulder). Use `mode_clear(mode="ralph")` for selective clearing |
| `boulder_progress` | Check completed vs remaining tasks in the active plan |

**Evidence tools** — Record verification results for the task-completed-verify hook:

| Tool | Purpose |
|------|---------|
| `evidence_log` | Record a verification result: `evidence_log(evidence_type, command, exit_code, output_snippet)` |
| `evidence_read` | Read accumulated verification evidence |
| `mode_clear` | Clear evidence records: `mode_clear(mode="evidence")` |

The `task-completed-verify.sh` hook (TaskCompleted event) exits 2 to block task completion
if `verification-evidence.json` is missing or older than 5 minutes when the task text
implies verification (words like "test", "verify", "fix", "implement").

**Notepad tools** — Per-plan knowledge accumulation for subagents:

| Tool | Purpose |
|------|---------|
| `notepad_write` | Append to a section: `notepad_write(plan_name, section, content)` |
| `notepad_read` | Read a section: `notepad_read(plan_name, section)` |
| `notepad_list` | List available plans and sections |

Sections: `learnings`, `issues`, `decisions`, `problems`, `questions`.

The `questions` section is the AskUserQuestion workaround for subagents: when a subagent
cannot ask the user directly (AskUserQuestion is stripped at depth 1), it writes to
`notepad_write(plan_name, "questions", "...")` and returns. The orchestrator checks
this section after each delegation and relays the question to the user.

### grep (HTTP, via Vercel — grep.app)

Public GitHub code search across approximately 1 million repositories.

Use for: finding real-world usage examples of libraries, discovering how a pattern is used
in practice across OSS, exploring API implementations.

Use local Grep for the current project. Use grep for external reference.

### context7 (HTTP, via context7.com)

Library documentation lookup. Two-step flow:

1. `context7_resolve-library-id` — Resolve a library name to a context7 ID
2. `context7_query-docs` — Query documentation for a specific topic

Prefer context7 over WebFetch for well-known libraries. Fall back to WebFetch or librarian
for niche or very recent libraries.

---

## Runtime State

The plugin stores all runtime state in `.omca/` in the project directory. This directory
is gitignored by default (omca-setup adds `.omca/` to `.gitignore`).

### Directory Structure

```
.omca/
  state/
    session.json                  # Session metadata, active mode, detected keywords
    agent-usage.json              # Agent delegation usage, tool call count
    injected-context-dirs.json    # Directories that have had context injected
    boulder.json                  # Active work plan (managed by omca-state MCP)
    verification-evidence.json    # Verification evidence records (managed by omca-state MCP)
    ralph-state.json              # Ralph persistence mode state
    ultrawork-state.json          # Ultrawork mode state
    compaction-context.md         # Saved state for compaction survival
    subagents.json                # Active agent spawn tracking
    notepads/
      {plan-name}/
        learnings                 # Findings from agents during plan execution
        issues                    # Blockers and unexpected problems
        decisions                 # Technical decisions made
        problems                  # Issues requiring human attention
        questions                 # Subagent questions waiting for user relay
  plans/
    {name}.md                     # Prometheus-generated work plans (checkboxed tasks)
  drafts/
    {name}.md                     # Prometheus working memory during interview
  logs/
    sessions.jsonl                # Session start/end events
    instructions-loaded.jsonl     # Instruction-load audit trail
    edits.jsonl                   # File edit audit trail
    subagents.jsonl               # Agent spawn/complete events
  rules/
    *.md                          # Project rules (auto-injected when matching files are read)
```

### Boulder Lifecycle

1. Prometheus creates a plan at `.omca/plans/{name}.md`
2. Prometheus calls `boulder_write(active_plan, plan_name, session_id)` to register it
3. `/start-work` reads boulder state and resumes from the last incomplete task
4. Atlas reads boulder state via `mode_read`, uses `boulder_progress` to check counts
5. When all tasks are complete, `/stop-continuation` or manual `mode_clear` clears it

### Evidence Workflow

After every build, test, or lint command:
```
evidence_log(evidence_type="build", command="just ci", exit_code=0, output_snippet="all checks passed")
```

The `task-completed-verify` hook reads `verification-evidence.json` on TaskCompleted
events and exits 2 to block completion if evidence is stale (> 5 minutes old) and the
task text implies verification was needed.

### Project Rules

Create `.omca/rules/name.md` with a `# pattern: <glob>` header:
```markdown
# pattern: *.tsx
React components in this project use functional components with hooks.
Never use class components.
```

When any file matching the glob is Read, Written, or Edited, the rule content (up to 1000
characters) is injected as additional context. Glob matching is filename-only — `*.tsx`
works, `src/**/*.tsx` does not.

---

## Keyword Activation

The `keyword-detector.sh` hook fires on `UserPromptSubmit`. It lowercases the prompt and
pattern-matches against known phrases, then injects `additionalContext` announcing the
detected mode. Claude reads the injection and invokes the corresponding skill.

### @-Mention Syntax

Type `@agent-oh-my-claudeagent:<name>` in any prompt to guarantee delegation to that
agent, bypassing the default routing decision. Examples:

```
@agent-oh-my-claudeagent:sisyphus please refactor this module
@agent-oh-my-claudeagent:oracle what's the right architecture here?
@agent-oh-my-claudeagent:explore find all usages of the auth middleware
```

This is the user-facing equivalent of `Agent(subagent_type="oh-my-claudeagent:NAME")`
in code. Use it when you want a specific specialist without invoking a skill.

### Full Keyword Map

| Keyword / Phrase | Activates |
|------------------|-----------|
| `ralph`, `don't stop`, `must complete`, `keep going until done`, `no stopping` | ralph mode — persistence loop |
| `ulw`, `ultrawork`, `parallel`, `as fast as possible`, `simultaneously` | ultrawork mode — parallel execution |
| `handoff`, `context is getting long`, `start fresh`, `summarize for new session` | session handoff |
| `cancel ralph` | cancel-ralph skill |
| `stop continuation`, `stop everything`, `pause automation`, `take manual control` | stop-continuation skill |
| `run atlas`, `atlas execute` | atlas skill |
| `run metis`, `metis analyze`, `pre-plan` | metis skill |
| `run prometheus`, `create plan` | prometheus-plan skill |
| `fix build`, `build broken` | hephaestus skill |
| `run sisyphus`, `orchestrate this` | sisyphus-orchestrate skill |
| `setup omca` | omca-setup skill |

### How Detection Works

1. User types a prompt containing a trigger phrase
2. `keyword-detector.sh` (UserPromptSubmit hook) reads the prompt from stdin JSON
3. Script outputs `{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "[MODE DETECTED] ..."}}`
4. Claude reads the injected context and invokes the skill via `/oh-my-claudeagent:NAME`
5. The skill activates and writes state if needed (ralph, ultrawork write to `.omca/state/`)

---

## Session Persistence

### Compaction Survival

When the context window fills, Claude Code compacts the conversation. The plugin preserves
critical state across compaction via a three-script pipeline:

1. **PreCompact** — `pre-compact.sh` saves active mode (ralph, ultrawork, boulder state)
   to `.omca/state/compaction-context.md`
2. **PostCompact** — `post-compact-log.sh` enriches the file with the compact_summary
   from upstream and logs the compaction event (stdout is not processed for
   `additionalContext` in PostCompact — side effects only)
3. **SessionStart (with "compact" matcher)** — `post-compact-inject.sh` reads the
   enriched file, injects it as `additionalContext`, and deletes it

This means ralph mode, active plans, and task state survive compaction.

### Context Injection on Read

`context-injector.sh` (PostToolUse, matcher: Read|Write|Edit) checks if the file's
parent directory contains an `AGENTS.md` or `README.md`. If it does, and if that directory
has not been injected recently (tracked in `injected-context-dirs.json`), the content is
injected as additional context.

Project rules in `.omca/rules/*.md` are matched on every Read/Write/Edit and injected when
the filename matches the rule's glob pattern.

### Ralph Stop-Blocking

`ralph-persistence.sh` runs on the Stop event. It reads `.omca/state/ralph-state.json`.
If ralph mode is active, it returns `{"decision": {"behavior": "block"}}` to prevent the
session from ending. The session continues until the oracle approves and ralph writes its
completed state.

### StopFailure Event

The `StopFailure` event fires when the session ends due to an API error (rate limit, auth
failure, network timeout, etc.). Unlike `Stop`, `StopFailure` is **logging-only**: Claude
Code ignores all output and exit codes from StopFailure hook scripts.

The plugin registers `stop-failure-handler.sh` (StopFailure event) which logs the error
type and details to `.omca/logs/stop-failures.jsonl`. This provides an audit trail but
**cannot block** the session from ending.

**Known limitation**: ralph mode has an unrecoverable gap for API errors. If a rate limit
or auth failure occurs during an active ralph or ultrawork session, the session ends and
the loop cannot continue. The user must manually resume by starting a new session and
running `/oh-my-claudeagent:start-work` (which reads boulder state to resume from the
last completed task).

### Notepad Injection for Subagents

When `.omca/state/boulder.json` has an active plan, `subagent-start.sh` (SubagentStart
event) injects two directives into every spawned agent:

1. A READ-ONLY warning for the plan file (prevents subagents from modifying the plan)
2. Notepad availability instructions with the plan name and `notepad_write` syntax

---

## Model Cost Awareness

### Default Tiers

| Agent | Model | Approximate cost |
|-------|-------|-----------------|
| sisyphus | opus | High |
| atlas | opus | High |
| prometheus | opus | High |
| metis | opus | High |
| momus | opus | High |
| oracle | opus | High |
| socrates | opus | High |
| sisyphus-junior | sonnet | Moderate |
| explore | sonnet | Moderate |
| librarian | sonnet | Moderate |
| hephaestus | sonnet | Moderate |
| multimodal-looker | sonnet | Moderate |

### Overriding the Model

Any agent's model can be overridden per call:

```
Agent(subagent_type="oh-my-claudeagent:explore", model="haiku")  # cheapest
Agent(subagent_type="oh-my-claudeagent:sisyphus-junior", model="opus")  # highest quality
```

### Overriding the Effort Level

The `effort` field controls the thinking token budget. Override per call or set as a
default in agent/skill frontmatter:

```
Agent(subagent_type="oh-my-claudeagent:oracle", effort="max")     # maximum thinking budget
Agent(subagent_type="oh-my-claudeagent:sisyphus-junior", effort="low")  # minimal thinking
```

Values: `max`, `high`, `medium`, `low`. Default is determined by the session's global
effort setting. Use `effort: max` for oracle on critical architecture reviews.

### Cost-Conscious Patterns

- Use `model="haiku"` for explore agents on quick lookups
- Use `model="sonnet"` (default) for standard implementation
- Use `model="opus"` only for complex logic that needs to get it right the first time
- Fire multiple haiku explore agents in parallel instead of one opus explore
- Oracle's 3-turn limit keeps its cost bounded even on complex queries
- Explore and librarian have 5-turn limits — they are designed to be cheap

---

## Troubleshooting

### permissionMode Stripping

Claude Code v2.1.77+ silently strips `permissionMode` from plugin agent frontmatter for
security. This means agents declared as `permissionMode: acceptEdits` may still prompt
for write permissions if the session is in default mode.

**Mitigation options:**
- Run `/oh-my-claudeagent:prometheus-plan` (exits plan mode, triggering the PermissionRequest
  hook which sets `acceptEdits` for the session)
- Copy the agent file to `~/.claude/agents/` — user-scope agents retain permissionMode
- In non-plan sessions, the session's existing mode applies

### Subagent Nesting Depth

The `Agent` tool is stripped from all subagents at depth 1+. Orchestrators (atlas, sisyphus)
invoked via `Agent()` will not be able to spawn further agents.

**Fix:** Always invoke orchestrators via their `context: fork` skills:
- `/oh-my-claudeagent:atlas` instead of `Agent(subagent_type="oh-my-claudeagent:atlas")`
- `/oh-my-claudeagent:sisyphus-orchestrate` instead of `Agent(...sisyphus...)`

The `delegate-retry.sh` hook detects "No such tool available: Agent" errors and injects
nesting-specific guidance.

### MCP Tools Not Available

If `ast_search`, `mode_read`, or other MCP tools are not responding:

1. Check that `ast-grep` or `sg` is installed: `command -v ast-grep || command -v sg`
2. Check that `uv` is installed: `command -v uv`
3. Run `/oh-my-claudeagent:omca-setup --check` to verify dependency status
4. Run `/reload-plugins` to reload the plugin and restart MCP servers
5. Restart the Claude Code session if MCP servers fail to start

MCP server logs appear in `.omca/logs/` during the session.

### Hook Changes Not Taking Effect

Hook changes in `hooks/hooks.json` are NOT auto-reloaded by the file watcher. Run
`/reload-plugins` to pick up plugin hook changes during development.

Changes to `.claude/settings.json` and `~/.claude/settings.json` are normally auto-
reloaded. If they have not appeared after a few seconds, restart the session.

### Global Config Split (v2.1.78+)

Several display/UI settings moved from `~/.claude/settings.json` to `~/.claude.json`
(a new per-user global config file separate from the project settings hierarchy):

- `showTurnDuration` — show elapsed time per turn
- `terminalProgressBarEnabled` — enable the terminal progress bar
- `editorMode` — terminal editor integration mode

If you previously set these in `~/.claude/settings.json`, move them to `~/.claude.json`.
The plugin does not write to `~/.claude.json` — use Claude Code's settings UI or edit
the file directly.

### Environment Variables

New Claude Code env vars relevant to this plugin:

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_CUSTOM_MODEL_OPTION` | Add a custom entry to the model picker. Companion vars: `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME` (display name) and `ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION` (tooltip text) |
| `CLAUDE_CODE_NEW_INIT=true` | Enable the interactive multi-phase `/init` flow (project initialization wizard) |
| `DISABLE_FEEDBACK_COMMAND` | Suppress the feedback/bug-report command. Replaces the old `DISABLE_BUG_COMMAND` name (old name still accepted for backwards compatibility) |

These are set in your shell environment before launching Claude Code and are not written
by omca-setup.

### AskUserQuestion Not Available in Subagents

AskUserQuestion is stripped from subagents at depth 1+ (platform bug, tracked at
GitHub #34592). The workaround:

- Subagents write questions to the notepad `questions` section:
  `notepad_write(plan_name, "questions", "Need clarification on X because Y")`
- Subagents return without waiting
- The orchestrator checks `notepad_read(plan_name, "questions")` after each delegation
- The orchestrator relays the question to the user and resumes the worker with the answer
  via `SendMessage({to: agentId, prompt: "User answered: ..."})`

The SubagentStart hook injects this protocol into all depth-1 agents automatically.

### Plan Mode Compatibility

Sisyphus does not set `permissionMode`, so it inherits plan mode restrictions. If invoked
during plan mode, it cannot execute edits.

**Fix:** Exit plan mode first (Shift+Tab or approve the plan), then invoke
`/oh-my-claudeagent:sisyphus-orchestrate`. Or use `/start-work` instead — atlas has
`permissionMode: acceptEdits` declared and handles plan mode override.

### Context Injection for External Directories

Agents with `permissionMode: plan` (explore, librarian, oracle, multimodal-looker) cannot
use Read for files outside the project root when spawned as subagents.

**Workaround:** Use Bash with `cat` for external file access:
```bash
cat /path/outside/project/file.py
```
This bypasses the plan mode scope restriction. multimodal-looker has no Bash access —
it cannot access external files at all.

### bypassPermissions Behavior (Refined)

`bypassPermissions` mode now prompts for writes to sensitive directories: `.git`, `.claude`,
`.vscode`, `.idea`. Writes to `.claude/commands`, `.claude/agents`, and `.claude/skills` are
exempt from the prompt (they are considered safe plugin artifact destinations).

If your workflows write plugin components programmatically to `.claude/agents/` or similar
paths, these writes will still succeed without a prompt. Writes directly to `.git` or `.claude`
at the root level will now request confirmation even in bypassPermissions mode.

### Read/Edit Deny Rules vs Bash Subprocesses

Read and Edit deny rules apply to Claude's built-in file tools only — not to Bash
subprocesses. A `Read(./.env)` deny rule blocks the Read tool but does not prevent
`cat .env` in a Bash call.

For OS-level enforcement, enable the sandbox. Deny rules without the sandbox are a
convenience guardrail, not a security boundary. The `permission-filter.sh` hook operates
on the `PermissionRequest` event, which fires for Claude's built-in Bash tool calls — it
does not intercept reads or writes inside scripts that Bash then executes.

### Scripted `-p` Calls and the `--bare` Flag

`--bare` flag (v2.1.81): Scripted `-p` calls with `--bare` skip hooks, LSP, plugin sync,
and skill directory walks. The oh-my-claudeagent plugin is entirely bypassed in this mode.
Requires `ANTHROPIC_API_KEY`. Auto-memory is disabled. Use `--bare` only when you need raw
Claude API access without any plugin behavior.

### Sandbox Path Prefix Changes

Sandbox path prefixes changed in v2.1.78: `/path` is now absolute (standard convention).
`./path` is relative to the project root. The older `//path` prefix for absolute paths still
works. If your omca-setup configured sandbox paths with `//`, consider migrating to single `/`.

---

## Enterprise Rollout

### Channels (v2.1.80, Research Preview)

MCP servers can push events into running sessions (Telegram, Discord integrations). Requires
the `--channels` flag when starting Claude Code and the `channelsEnabled` managed setting for
Team/Enterprise deployments. See upstream docs for setup. This is a research preview — the API
may change before general availability.

### Managed Settings Keys

When deploying oh-my-claudeagent organization-wide, configure non-overridable policy in
managed Claude Code settings. The relevant keys:

| Key | Purpose |
|-----|---------|
| `strictKnownMarketplaces` | Allow only marketplaces your admins have approved |
| `blockedMarketplaces` | Explicitly deny specific marketplaces |
| `allowManagedHooksOnly` | Allow only hooks defined in managed settings |
| `allowManagedPermissionRulesOnly` | Allow only managed permission rules |
| `allowManagedMcpServersOnly` | Allow only managed MCP server definitions |
| `channelsEnabled` | Managed setting for Team/Enterprise channel access (required alongside `--channels` flag) |
| `sandbox.filesystem.allowRead` | Re-allow reads within a broader `denyRead` region |
| `sandbox.filesystem.allowManagedReadPathsOnly` | Managed-only setting; prevents user overrides of read paths |

omca-setup inspects and reports on these keys but does not write them — managed policy
is set by your admin tooling, not by this plugin.

**Removed managed key:** `allow_remote_sessions` is no longer a managed settings key — it
is now controlled via the admin UI instead of settings files.

### Plugin Seed and Inline Install

`CLAUDE_CODE_PLUGIN_SEED_DIR` now supports multiple paths separated by `:` on Unix or `;`
on Windows. This allows seeding multiple plugin directories in enterprise images without
requiring marketplace commands:

```bash
export CLAUDE_CODE_PLUGIN_SEED_DIR=/opt/company-plugins:/opt/shared-plugins
```

As an alternative to a hosted marketplace, declare the plugin inline using `source: 'settings'`
in `settings.json`. This is already documented in the "Inline Settings Install" section above.

### Plugin Validation

`claude plugin validate` now checks both YAML frontmatter syntax (in agent/skill/hook files)
and `hooks.json` schema. Run this after modifying plugin files to catch structural errors
before committing:

```bash
claude plugin validate /path/to/oh-my-claudeagent
```

### Install Path

Marketplace installs are copied to `~/.claude/plugins/cache/omca/oh-my-claudeagent/`.
Bundled scripts and configs reference files inside the plugin root only. MCP server
launchers use `uv run --project` for dependency management within the plugin root.

### Team Settings Snippet

Add to the project's `.claude/settings.json`:
```json
{
  "extraKnownMarketplaces": {
    "omca": {
      "source": {"source": "github", "repo": "UtsavBalar1231/oh-my-claudeagent"}
    }
  },
  "enabledPlugins": {"oh-my-claudeagent@omca": true}
}
```

For detailed enterprise rollout guidance, see `docs/audit/enterprise-policy-guide.md`
(available locally after install — this file is not tracked in git).

---

## Architecture (for Contributors)

### Markdown-First Design

oh-my-claudeagent has no TypeScript build step (ADR-001). Everything is markdown files
(agents, skills), shell scripts (hooks), and Python FastMCP servers (MCP). Plugin load is
fast; contributors edit markdown directly.

### Hook Scripts

All hook scripts in `scripts/*.sh` follow these conventions:
- Read JSON hook payload from stdin, parse with `jq`
- Write state atomically: `tmp=$(mktemp) && ... && mv "$tmp" target.json`
- Return JSON on stdout when action is needed
- Default to exit 0 — degrade gracefully when conditions do not apply
- Never use `set -euo pipefail`
- State files live in `.omca/state/` relative to `CLAUDE_PROJECT_ROOT`

A script not registered in `hooks/hooks.json` is dead code (ADR-009). Both the script
and the registration are required.

**Compound command permission splitting:** When a user approves a compound Bash command
(e.g., `git status && npm test`) with "Yes, don't ask again", Claude Code now saves
separate permission rules per subcommand — up to 5 subcommands per approval. This means
approving `git status && npm test` saves an independent rule for `npm test`. The
`permission-filter.sh` hook auto-approves known-safe commands; this splitting means
previously-approved compound commands may now generate individual approval records for
each subcommand, which is expected behavior.

### Adding New Components

**Hook script:**
1. Create `scripts/name.sh`
2. Register in `hooks/hooks.json`:
   ```json
   {
     "matcher": "ToolName",
     "hooks": [{"type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/name.sh"}]
   }
   ```

**Agent:**
1. Create `agents/name.md` with YAML frontmatter:
   ```yaml
   ---
   name: agent-name
   description: One-line role description
   model: opus|sonnet|haiku
   effort: max|high|medium|low  # optional: override session effort level (thinking budget)
   disallowedTools: Write, Edit  # use disallowedTools, never tools: (blocks MCP inheritance)
   background: true              # optional: run in background by default
   isolation: worktree           # optional: run in an isolated git worktree
   maxTurns: 30
   ---
   ```
   If both `disallowedTools` and `tools` are set, `disallowedTools` is applied first (to the
   full inherited tool set), then `tools` creates a further allowlist. Prefer `disallowedTools`
   alone — never use `tools:` only, as it blocks MCP tool inheritance.

**Skill:**
1. Create `skills/name/SKILL.md` — a skill directory without `SKILL.md` is ignored
2. If keyword-activated, add detection pattern to `scripts/keyword-detector.sh`
3. For agent command skills, add `context: fork` and `agent: oh-my-claudeagent:NAME`

**Project rule:**
1. Create `.omca/rules/name.md` with `# pattern: <glob>` as the first line
2. Add the rule content (up to 1000 characters — the rest is ignored)

### Development Commands

```bash
just setup           # Install dev deps (ruff, pre-commit) and git hooks
just lint            # shellcheck + ruff check
just fmt             # ruff format
just test            # validate-plugin.sh --check claims --check hooks
just test-claims     # Structural validation (CLAUDE.md claims vs on-disk files)
just test-hooks      # Hook scripts with fixture payloads
just test-mcp        # MCP server tool listing validation
just ci              # Full CI pipeline: fmt-check + lint + test
just release         # Stamp HEAD SHA into marketplace.json
```

### Testing Hooks

```bash
echo '{"prompt": "ralph dont stop"}' | bash scripts/keyword-detector.sh
echo '{"tool_name": "Write", "tool_input": {"file_path": "foo.py", "content": ""}}' | bash scripts/write-guard.sh
```

Hook fixture payloads live in `tests/fixtures/hooks/`.

### Key Source Files

| File | Purpose |
|------|---------|
| `agents/*.md` | 12 agent definitions |
| `skills/*/SKILL.md` | 20 skill definitions |
| `scripts/*.sh` | 29 scripts: 28 hook commands + `validate-plugin.sh` utility |
| `hooks/hooks.json` | Hook registration (canonical source for hook map) |
| `servers/omca-mcp.py` | Unified Python FastMCP server (ast-grep, boulder, evidence, notepads, catalog) |
| `.mcp.json` | Wires 3 MCP servers: omca (local), grep (HTTP), context7 (HTTP) |
| `settings.json` | Sets default agent to `oh-my-claudeagent:sisyphus` |
| `templates/claudemd.md` | Runtime behavioral spec, injected into ~/.claude/CLAUDE.md |
| `statusline/` | Separate Python package (cc-statusline) for terminal status rendering |
| `tests/fixtures/` | JSON payloads for hook and MCP validation |
| `.claude-plugin/plugin.json` | Plugin manifest (version authority) |
| `.claude-plugin/marketplace.json` | Marketplace catalog |

For consolidated architectural decision records (ADR-001 through ADR-015), see
`docs/adr/README.md` (available locally — not tracked in git).
