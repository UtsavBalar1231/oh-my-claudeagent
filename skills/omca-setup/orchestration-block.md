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
| sisyphus          | claude-opus-4-8[1m] | Orchestration — free-form and plan execution (via `/start-work` command) |
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
5. `/oh-my-claudeagent:start-work` executes the approved plan end-to-end at depth 0 — the main session (sisyphus identity) spawns `executor` for each task (parallel where the plan declares `Parallel Execution: YES`), invokes `oracle` for F1 independent review, logs evidence per task with `plan_sha256`, and reports completion back to the user.

User runs `/oh-my-claudeagent:start-work [plan path]`. Do not auto-start execution.

## Parallel execution

> **Main-session orchestrator (sisyphus) only.** If you are a subagent (executor, explore, librarian, oracle, hephaestus, or any other spawned agent), this section does NOT apply to you. Subagents must never wait for other agents — always complete your assigned work and end with your full deliverable.

Fan out independent tasks **synchronously in parallel** — this is the default:

1. Multiple `Agent` blocks in ONE message, NO `run_in_background` → they run concurrently; the turn blocks until all return; each tool result IS that agent's full deliverable, read directly.
2. Do NOT background an agent whose result you immediately need. A background completion `<task-notification>` is a trigger + output-file path, NOT the deliverable — backgrounding fan-out work is what causes the "agent returned only a stub, re-querying…" loop.
3. Never Read a subagent's `.output`/JSONL transcript (overflows context) and never re-query a finished agent via `SendMessage` — a stub return IS its final answer; relaunch a fresh agent with a sharper prompt instead.
4. Background (`run_in_background=true`) is reserved for genuine non-overlapping meanwhile-work or file-based-output skills. Then collect the deliverable from the Agent tool result on completion — never from a notification or a running-count. End the response once if you must wait; never re-emit a bare wait/holding message on two consecutive turns for the same agents.

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
