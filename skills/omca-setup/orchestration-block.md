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
| Parallel work            | "ultrawork" / "ulw"    | /oh-my-claudeagent:ultrawork <task list> |
| Must-finish persistence  | "ralph" / "don't stop" | /oh-my-claudeagent:ralph <task>          |
| Fix broken build         | "fix build"            | /oh-my-claudeagent:hephaestus            |
| Session handoff          | "handoff"              | /oh-my-claudeagent:handoff               |
| Stop all continuation    | "stop continuation"    | /oh-my-claudeagent:stop-continuation     |

## Agent catalog

| Agent             | Model  | Use when                                                                 |
| ----------------- | ------ | ------------------------------------------------------------------------ |
| sisyphus          | claude-fable-5[1m] | Orchestration — free-form and plan execution (via `/start-work` command) |
| prometheus        | claude-fable-5[1m] | Interviewing the user, Socratic deep-dive, producing structured plans    |
| metis             | claude-fable-5[1m] | Pre-execution gap analysis on a draft plan                               |
| momus             | claude-fable-5[1m] | Critical review of a draft plan for clarity and risk                     |
| executor          | sonnet | Focused implementation of a known, scoped task                           |
| explore           | sonnet | Finding code and patterns inside the local repo                          |
| librarian         | sonnet | External docs, library usage, OSS examples, research                     |
| oracle            | claude-fable-5[1m] | Architecture, tradeoffs, stuck debugging, craft review                   |
| hephaestus        | sonnet | Build failures, type errors, toolchain/dep fixes                         |
| multimodal-looker | sonnet | Screenshots, PDFs, diagrams, visual inputs                               |

## Workflow

Pipeline: **prometheus → metis → momus → user approval → `/oh-my-claudeagent:start-work`.**

1. `prometheus` interviews user (optionally in Socratic Interview Mode), drafts plan.
2. `metis` gap-analyzes the draft.
3. `momus` reviews for clarity, verifiability, completeness.
4. **User approves** (ExitPlanMode or confirmation).
5. `/oh-my-claudeagent:start-work` executes the approved plan end-to-end at depth 0 — the main session (sisyphus identity) spawns `executor` for each task (parallel where the plan declares `Parallel Execution: YES`), invokes `oracle` for F1 independent review, logs evidence per task with `plan_sha256`, and reports completion back to the user.

User runs `/oh-my-claudeagent:start-work [plan path]`. Do not auto-start execution.

## Parallel execution

> **Main-session orchestrator (sisyphus) only.** If you are a subagent (executor, explore, librarian, oracle, hephaestus, or any other spawned agent), this section does NOT apply to you. Subagents must never wait for other agents — always complete your assigned work and end with your full deliverable.

Multiple background agents when tasks are independent:

1. Multiple `Agent` blocks with `run_in_background=true` in ONE message → parallel fan-out.
2. Remaining work depends on results → end response, wait for notifications.
3. Apply background-agent barrier on every partial completion (acknowledge result, "Waiting for N more", END response).
4. Synthesize only after all N in.

Sequence when output feeds next task, need one result to frame another, or downstream needs upstream context.

## Verification

Record every build/test/lint via `evidence_log` MCP tool before marking complete — enforced by platform Stop hook, not a suggestion.

Escalate to `oracle` after **2+ failed fixes**. Stop shotgun-debugging. Oracle steps back and finds root cause.

Multi-system tradeoffs, unfamiliar patterns, multi-module decisions → get oracle read before committing. Early oracle is cheap; late oracle is not.

## File reading outside project root

Files outside the project root → `file_read` MCP tool (via ToolSearch). Built-in Read is scoped to project root for subagents.

`file_read` returns line-numbered content with token count, line count, remaining lines.

- **Default**: `file_read(path="/path")` — up to 5000 lines.
- **Targeted**: `file_read(path="/path", offset=100, limit=50)` — lines 101-150.
- **Size check**: `limit=1` first to see totals.

Large files → targeted reads to conserve context.
