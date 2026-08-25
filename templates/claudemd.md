# oh-my-claudeagent orchestration guidance

Claude Code session with **oh-my-claudeagent** (OMCA) installed. OMCA is a multi-agent orchestration layer. This block is user-scope (auto-loaded for every Claude Code session). The output style at `output-styles/omca-default.md` carries the always-on principles, negative constraints, and communication rules; the agent catalog and delegation table live in this file.

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
| Session handoff          | "handoff" (advisory nudge only) | /oh-my-claudeagent:handoff      |

## Agent catalog

Every agent but `oracle` runs on `opus`, so the model column does not separate them. `effort:` does, and each agent declares the level its role needs.

| Agent             | Model            | Effort  | Use when                                                                 |
| ----------------- | ---------------- | ------- | ------------------------------------------------------------------------ |
| sisyphus          | opus             | xhigh   | Orchestration: free-form and plan execution (via `/start-work` command) |
| prometheus        | opus             | xhigh   | Interviewing the user, Socratic deep-dive, producing structured plans    |
| metis             | opus             | xhigh   | Pre-execution gap analysis on a draft plan                               |
| momus             | opus             | xhigh   | Critical review of a draft plan for clarity and risk                     |
| executor          | opus             | medium  | Focused implementation of a known, scoped task                           |
| explore           | opus             | low     | Finding code and patterns inside the local repo                          |
| librarian         | opus             | medium  | External docs, library usage, OSS examples, research                     |
| oracle            | fable            | max     | Architecture, tradeoffs, stuck debugging, craft review                   |
| hephaestus        | opus             | medium  | Build failures, type errors, toolchain/dep fixes                         |
| multimodal-looker | opus             | medium  | Screenshots, PDFs, diagrams, visual inputs                               |

Scale a delegation by picking the agent whose declared effort fits the work, not by passing a different model.

## Workflow

Pipeline: **prometheus → metis → momus → user approval → `/oh-my-claudeagent:start-work`.**

1. `prometheus` interviews user (optionally in Socratic Interview Mode), drafts plan.
2. `metis` gap-analyzes the draft.
3. `momus` reviews for clarity, verifiability, completeness.
4. **User approves** (ExitPlanMode or confirmation).
5. `/oh-my-claudeagent:start-work` executes the approved plan end-to-end at depth 0. The main session (sisyphus identity) spawns `executor` for each task (parallel where the plan declares `Parallel Execution: YES`), logs evidence per task, and runs a final completeness check before reporting back to the user.

User runs `/oh-my-claudeagent:start-work [plan path]`. Do not auto-start execution.

## Cross-cutting policy

- **Delegation-first**: the main session orchestrates; specialist work goes to the agents above. Direct edits are reserved for trivially small, already-known changes.
- **Evidence-first**: every build, test, or lint verification is logged via `evidence_log` before a completion claim is made.
- **Plan pipeline**: `/oh-my-claudeagent:plan` drafts a plan through the prometheus/metis/momus pipeline; `/oh-my-claudeagent:start-work` executes an approved plan end to end.

## Parallel execution and verification

The canonical rules for routing, parallel fan-out, and evidence discipline live in the specialist agent bodies (`agents/*.md`) and `commands/start-work.md`, not in a single shared section: each agent's own instructions cover what applies to it. The output style (see `output-styles/omca-default.md`, sections "Principles" and "Communication") carries the cross-cutting, always-on discipline that every turn should follow regardless of role.

Spawn a subagent with the Agent tool and do not pass `run_in_background`. In an interactive
session on Claude Code v2.1.232 or later, fork mode is on by default and the platform
removes that parameter from the Agent tool, so your call returns at once with a launch
acknowledgement, an agent id, and an output file path, and the subagent runs in the
background whether or not you wanted the foreground. Read the deliverable from the
`<result>` block of the `<task-notification>` system message that arrives in a later turn;
that block carries the agent's complete final message, so treat it as the deliverable and
relay what matters from it to the user. Do not read or tail the output file: for a subagent
it is the full JSONL transcript rather than a plain result, and reading it will overflow
your context. Under `claude -p` and in the Agent SDK fork mode is off by default, and the
platform may instead run a subagent in the foreground and hand you its result as the Agent
tool's return value, so accept either path and never claim a result you have not actually
received. While any agent is outstanding, end your turn and wait for its notification
rather than predicting, fabricating, or polling for a result that has not arrived.

In brief: as the main-session orchestrator, record every build/test/lint via `evidence_log` before marking complete, and escalate to `oracle` after 2+ failed fixes.

If you are a spawned subagent (leaf worker), the parallel and barrier guidance does not apply to you. Complete your own task and end with your full deliverable inline, never a bare status word and never a "waiting for other agents" message.
