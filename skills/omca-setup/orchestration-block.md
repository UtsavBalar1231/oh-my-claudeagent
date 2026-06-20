# oh-my-claudeagent orchestration guidance

Claude Code session with **oh-my-claudeagent** (OMCA) installed. OMCA is a multi-agent orchestration layer. This block is user-scope (auto-loaded for every Claude Code session). The lightweight output-style at `output-styles/omca-default.md` carries the principles + delegation table; this file carries the practical operational guidance.

## Entrypoints

Slash commands always available. Keyword triggers activate only when `enableKeywordTriggers` is on (opt-in, off by default).

| Need                     | Keyword                | Slash command                            |
| ------------------------ | ---------------------- | ---------------------------------------- |
| Setup                    | "setup omca"           | /oh-my-claudeagent:omca-setup            |
| Create plan              | "create plan"          | /oh-my-claudeagent:plan <task>           |
| Gap-analyze a draft plan | —                      | /oh-my-claudeagent:metis                 |
| Review a draft plan      | —                      | /oh-my-claudeagent:momus                 |
| Start execution          | —                      | /oh-my-claudeagent:start-work            |
| Fix broken build         | "fix build"            | /oh-my-claudeagent:hephaestus            |
| Session handoff          | "handoff"              | /oh-my-claudeagent:handoff               |

## Agent catalog

| Agent             | Model  | Use when                                                                 |
| ----------------- | ------ | ------------------------------------------------------------------------ |
| sisyphus          | claude-opus-4-8[1m] | Orchestration: free-form and plan execution (via `/start-work` command) |
| prometheus        | claude-opus-4-8[1m] | Interviewing the user, Socratic deep-dive, producing structured plans    |
| metis             | claude-opus-4-8[1m] | Pre-execution gap analysis on a draft plan                               |
| momus             | claude-opus-4-8[1m] | Critical review of a draft plan for clarity and risk                     |
| executor          | sonnet | Focused implementation of a known, scoped task                           |
| explore           | sonnet | Finding code and patterns inside the local repo                          |
| librarian         | sonnet | External docs, library usage, OSS examples, research                     |
| oracle            | claude-opus-4-8[1m] | Architecture, tradeoffs, stuck debugging, craft review                   |
| hephaestus        | sonnet | Build failures, type errors, toolchain/dep fixes                         |
| multimodal-looker | sonnet | Screenshots, PDFs, diagrams, visual inputs                               |

## Workflow

Pipeline: **prometheus → metis → momus → user approval → `/oh-my-claudeagent:start-work`.**

1. `prometheus` interviews user (optionally in Socratic Interview Mode), drafts plan.
2. `metis` gap-analyzes the draft.
3. `momus` reviews for clarity, verifiability, completeness.
4. **User approves** (ExitPlanMode or confirmation).
5. `/oh-my-claudeagent:start-work` executes the approved plan end-to-end at depth 0. The main session (sisyphus identity) spawns `executor` for each task (parallel where the plan declares `Parallel Execution: YES`), logs evidence per task, and runs a final completeness check before reporting back to the user.

User runs `/oh-my-claudeagent:start-work [plan path]`. Do not auto-start execution.

## Parallel execution and verification

The full rules live in the OMCA output style's `<critical_rules>`, which is auto-applied every session, so they are not duplicated here. In brief: as the main-session orchestrator, fan out independent work as synchronous parallel `Agent` calls and read each result inline; record every build/test/lint via `evidence_log` before marking complete; escalate to `oracle` after 2+ failed fixes.

If you are a spawned subagent (leaf worker), the parallel and barrier guidance does not apply to you. Complete your own task and end with your full deliverable inline, never a bare status word and never a "waiting for other agents" message.

## File reading outside project root

Files outside the project root → `file_read` MCP tool (via ToolSearch). Built-in Read is scoped to project root for subagents.

`file_read` returns line-numbered content with token count, line count, remaining lines.

- **Default**: `file_read(path="/path")` reads up to 5000 lines.
- **Targeted**: `file_read(path="/path", offset=100, limit=50)` reads lines 101-150.
- **Size check**: `limit=1` first to see totals.

Large files → targeted reads to conserve context.
