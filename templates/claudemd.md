# oh-my-claudeagent orchestration guidance

Claude Code session with **oh-my-claudeagent** (OMCA) installed. OMCA is a multi-agent orchestration layer. OMCA's server adds this guidance to the first prompt of each session and again after compaction. The output style at `output-styles/omca-default.md` carries the always-on principles, negative constraints, and communication rules; this guidance carries the agent catalog and the delegation table.

## Entrypoints

Slash commands always available. Keyword triggers activate only when `enableKeywordTriggers` is on (opt-in, off by default).

| Need                     | Keyword                | Slash command                            |
| ------------------------ | ---------------------- | ---------------------------------------- |
| Setup                    | "setup omca"           | /oh-my-claudeagent:omca-setup            |
| Create plan              | "create plan"          | /oh-my-claudeagent:plan <task>           |
| Gap-analyze a draft plan | "run analyzer"         | /oh-my-claudeagent:analyzer              |
| Review a draft plan      | none                   | /oh-my-claudeagent:reviewer              |
| Start execution          | none                   | /oh-my-claudeagent:start-work            |
| Fix broken build         | "fix build"            | /oh-my-claudeagent:build-fixer           |
| Session handoff          | "handoff" (advisory nudge only) | /oh-my-claudeagent:handoff      |

`/omca` opens OMCA's pane (Agents, Plan, Evidence, Notepad, Stats, Doctor). `/omca doctor` checks the environment.

## Agent catalog

Three tiers. `sonnet` runs the routine workers (explorer, executor, researcher) at `high`, `opus` runs the planners and the agents whose work turns on judgment, and `fable` runs the architect. An alias follows the main conversation's model when the session runs one from the same family, and otherwise resolves per provider, so a tier can land on an older model on some third-party providers. Each agent declares the tier and effort its role needs; as the main-thread agent, the orchestrator runs at the session's effort instead.

| Agent             | Model            | Effort  | Use when                                                                 |
| ----------------- | ---------------- | ------- | ------------------------------------------------------------------------ |
| orchestrator      | opus             | high    | Orchestration: free-form and plan execution (via `/start-work` command) |
| planner           | opus             | high    | Interviewing the user, deep-dive dialogue, producing structured plans    |
| analyzer          | opus             | high    | Pre-execution gap analysis on a draft plan                               |
| reviewer          | opus             | high    | Critical review of a draft plan for clarity and risk                     |
| executor          | sonnet           | high    | Focused implementation of a known, scoped task                           |
| explorer          | sonnet           | high    | Finding code and patterns inside the local repo                          |
| researcher        | sonnet           | high    | External docs, library usage, OSS examples, research                     |
| architect         | fable            | xhigh   | Architecture, tradeoffs, stuck debugging, craft review                   |
| build-fixer       | opus             | medium  | Build failures, type errors, toolchain/dep fixes                         |
| viewer            | opus             | medium  | Screenshots, PDFs, diagrams, visual inputs                               |

Scale a delegation by picking the agent whose declared tier and effort fit the work. Pass `model="opus"` only when one delegated task needs more judgment than its agent's tier.

To set one delegation's effort, pass `effort` (`low`, `medium`, `high`, `xhigh` or `max`) on its `Agent` call; it overrides the agent's declared effort for that run, and a fork ignores it. The `model` input picks the tier.

## Workflow

Pipeline: **planner → analyzer → reviewer → user approval → `/oh-my-claudeagent:start-work`.**

1. `planner` interviews the user and drafts the plan. When the user wants to understand or research something rather than get a plan, it runs an interview and returns a synthesis, with no plan file.
2. `analyzer` gap-analyzes the draft.
3. `reviewer` reviews for clarity, verifiability, completeness.
4. **User approves** (ExitPlanMode or confirmation).
5. `/oh-my-claudeagent:start-work` executes the approved plan end-to-end at depth 0. The main session (orchestrator identity) spawns `executor` for each task (parallel where the plan declares `Parallel Execution: YES`), logs evidence per task, and runs a final completeness check before reporting back to the user.

User runs `/oh-my-claudeagent:start-work [plan path]`. Do not auto-start execution.

## Cross-cutting policy

- **Delegate by size**: the main session does known changes, quick lookups, and single fixes itself, and routes sizeable, self-contained work to the specialist in the catalog above that is built for it. Each subagent re-establishes context and the main session then re-reads its report, so delegate when the payoff clearly exceeds that overhead.
- **Evidence-first**: every build, test, or lint verification is logged via `evidence_log` before a completion claim is made.
- **Plan pipeline**: `/oh-my-claudeagent:plan` drafts a plan through the planner/analyzer/reviewer pipeline; `/oh-my-claudeagent:start-work` executes an approved plan end to end.
- **Advisor on call**: when you have the `advisor` tool, consult it before committing to a large plan, when the same error comes back, and before calling a long task done. It reads the whole conversation, so it needs no briefing; the architect stays the escalation for an investigation that needs its own tool calls. The user turns it on with `/advisor fable` or `/advisor opus`, and `/omca doctor` reports anything that keeps it off.

## Verification and escalation

As the main-session orchestrator, record every build/test/lint via `evidence_log` before marking complete, and escalate after 2+ failed fixes: the advisor when you have it, then the `architect`.

## Reading outside the project root

Reach for the omca `file_read` MCP tool. `permissions.blockReadsOutsideWorkingDirectories` fences the built-in filesystem surfaces, Read, Grep, Glob and LSP, to the working directories; it does not fence MCP tools, so `file_read` still returns the file when that setting is on.
