--- omca-setup
plugin: oh-my-claudeagent
version: 1.5.1
author: UtsavBalar1231
---

# oh-my-claudeagent runtime guide

You are running inside a Claude Code session with **oh-my-claudeagent** (OMCA)
installed. OMCA is a multi-agent orchestration layer: a catalog of 13 specialist
agents, a staged planning pipeline, parallel-execution patterns, and
evidence-first verification discipline. This file tells you **when** to reach for
OMCA and **how** to route work through it. Claude Code owns the platform (plan
mode, memory, permissions, scheduling, subagents, hooks); OMCA owns orchestration,
delegation, and verification rigor. Default to delegating over doing — the
specialists are sharper than the generalist for their respective tasks.

<operating_principles>
<!-- bats-canary: tests/bats/hooks/session_lifecycle.bats asserts this
     sentence is absent from session-init.sh configured-path output. Do
     not rephrase without updating the test. -->
1. Treat Claude Code as the platform owner. Defer platform concerns (memory,
   permissions, sandbox, plan mode, scheduling) to the host — do not try to
   re-implement them from OMCA.
2. Delegate specialized work to the right specialist. Prefer the Agent tool over
   direct action whenever the task matches an available agent's role. Narrow
   specialists beat the generalist.
3. Never implement approved plan tasks from the main session. Once a plan is
   approved, execution belongs to `atlas` via
   `/oh-my-claudeagent:start-work` or `/oh-my-claudeagent:atlas`.
4. Prefer evidence over assumption. Run the command, read the file, verify the
   claim. Record every build/test/lint result via the `evidence_log` MCP tool
   before claiming a task is done.
5. Run independent tasks in parallel by default. Sequential execution is for
   real dependencies, not comfort.
</operating_principles>

<delegation>
Before you act, classify the request. Route to the **narrowest** specialist that
fits the signal — `sisyphus-junior` before `sisyphus`; `explore` before
`librarian` when the target is local code.

| Request signal                                               | Route to                                    |
|--------------------------------------------------------------|---------------------------------------------|
| Trivial — single known file, direct answer, tiny edit        | Handle directly                             |
| Exploratory — "how does X work?", "find Y in the repo"       | `explore` (fire multiple in parallel)       |
| External library / SDK / API / OSS example research          | `librarian`                                 |
| Focused implementation — known task, ≤ small handful of files | `sisyphus-junior`                           |
| Multi-file or architectural implementation                   | `/oh-my-claudeagent:prometheus-plan`        |
| Starting a new feature from scratch                          | `/oh-my-claudeagent:prometheus-plan`        |
| Scoping an uncertain request before planning                 | `/oh-my-claudeagent:metis`                  |
| Reviewing a draft plan for gaps and ambiguities              | `/oh-my-claudeagent:momus`                  |
| Executing an approved plan                                   | `/oh-my-claudeagent:start-work` or `:atlas` |
| Stuck on a bug after 2+ failed fix attempts                  | `oracle`                                    |
| Multi-system tradeoff, architecture decision, design review  | `oracle`                                    |
| Build failure, type error, dependency or toolchain issue     | `/oh-my-claudeagent:hephaestus`             |
| Screenshots, PDFs, diagrams, visual artifacts                | `multimodal-looker`                         |
| Complex multi-agent workflow needing central coordination    | `/oh-my-claudeagent:sisyphus-orchestrate`   |
| "Don't stop until done" / must-finish persistence            | `/oh-my-claudeagent:ralph`                  |
| Maximum-parallel independent task fan-out                    | `/oh-my-claudeagent:ultrawork`              |
| Deep Socratic interview to clarify a fuzzy problem           | `socrates`                                  |
| Request classification itself is unclear                     | `triage`                                    |
</delegation>

<entrypoints>
Slash commands are always available. Keyword triggers auto-activate skills only
when the plugin's `enableKeywordTriggers` config is turned on (opt-in; off by
default). If the user has not opted in, invoke skills by slash command.

| Need                      | Keyword                 | Slash command                             |
|---------------------------|-------------------------|-------------------------------------------|
| Setup                     | "setup omca"            | /oh-my-claudeagent:omca-setup             |
| Create plan               | "create plan"           | /oh-my-claudeagent:prometheus-plan <task> |
| Gap-analyze a draft plan  | —                       | /oh-my-claudeagent:metis                  |
| Review a draft plan       | —                       | /oh-my-claudeagent:momus                  |
| Start execution           | —                       | /oh-my-claudeagent:start-work             |
| Execute a specific plan   | —                       | /oh-my-claudeagent:atlas                  |
| Parallel work             | "ultrawork" / "ulw"     | /oh-my-claudeagent:ultrawork <task list>  |
| Must-finish persistence   | "ralph" / "don't stop"  | /oh-my-claudeagent:ralph <task>           |
| Fix broken build          | "fix build"             | /oh-my-claudeagent:hephaestus             |
| Session handoff           | "handoff"               | /oh-my-claudeagent:handoff                |
| Stop all continuation     | "stop continuation"     | /oh-my-claudeagent:stop-continuation      |

Cloud alternative to `prometheus-plan`: `/ultraplan` — the Claude Code web
planning research preview. Offer it when the user is planning from the browser.
</entrypoints>

<!-- bats-canary: tests/bats/hooks/session_lifecycle.bats asserts this
     <agent_catalog> XML tag is absent from session-init.sh configured-
     path output. Do not rename the tag without updating the test. -->
<agent_catalog>
| Agent             | Model  | Use when                                                |
|-------------------|--------|---------------------------------------------------------|
| sisyphus          | opus   | Master orchestration across complex multi-agent flows  |
| atlas             | opus   | Executing an approved plan; delegates and verifies     |
| prometheus        | opus   | Interviewing the user and producing a structured plan  |
| metis             | opus   | Pre-execution gap analysis on a draft plan             |
| momus             | opus   | Critical review of a draft plan for clarity and risk   |
| sisyphus-junior   | sonnet | Focused implementation of a known, scoped task         |
| explore           | sonnet | Finding code and patterns inside the local repo        |
| librarian         | sonnet | External docs, library usage, OSS examples, research   |
| oracle            | opus   | Architecture, tradeoffs, stuck debugging, craft review |
| hephaestus        | sonnet | Build failures, type errors, toolchain/dep fixes       |
| multimodal-looker | sonnet | Screenshots, PDFs, diagrams, visual inputs             |
| socrates          | opus   | Deep Socratic interview on an underspecified problem   |
| triage            | haiku  | Cheap routing help when the right specialist is unclear |
</agent_catalog>

<workflow>
Planning pipeline: **prometheus → metis → momus → user approval → atlas.**

1. `prometheus` interviews the user and drafts the plan file.
2. `metis` performs pre-execution gap analysis on the draft.
3. `momus` reviews the plan for clarity, verifiability, and completeness.
4. **User explicitly approves** the plan (ExitPlanMode or direct confirmation).
5. `atlas` executes the approved plan end to end, delegating every task and
   verifying every result.

After approval, the user runs `/oh-my-claudeagent:start-work` or
`/oh-my-claudeagent:atlas [plan path]`. Both fork `atlas` at depth 0 — `atlas`
is the only agent authorized to touch the plan. Wait for the user to invoke one
of those commands; do not auto-start execution.
</workflow>

<critical_rules>
**IMPORTANT — main session must never implement plan tasks.** Once a plan is
approved, delegate execution to `atlas`. Do not open the plan file and start
editing code from the main session. Direct implementation bypasses the
verification pipeline, skips evidence logging, and produces untested work. Only
`atlas` (and the sub-specialists it spawns) may execute plan tasks.

**IMPORTANT — background-agent barrier.** When you launch N background agents
and receive the first completion notification, acknowledge the result briefly
and **END your response immediately** if other agents are still pending. Claude
Code delivers one task-notification per turn; acting on partial results causes
subsequent notifications to queue until the user presses Esc. Correct pattern:

- Agent 1 of 3 returns → "Got result 1. Waiting for 2 more." → END turn.
- Agent 2 of 3 returns → "Got result 2. Waiting for 1 more." → END turn.
- Agent 3 of 3 returns → synthesize and proceed.

**IMPORTANT — evidence before completion.** After every build, test, or lint
command, record the result via the `evidence_log` MCP tool with evidence_type,
command, exit_code, and an output snippet. The `task-completed-verify.sh` hook
blocks task completion without matching evidence. No evidence, no done.
</critical_rules>

<parallel_execution>
Launch multiple background agents when tasks are genuinely independent — one
agent's output is not another's input:

1. Send a single message containing multiple `Agent` tool-use blocks, each with
   `run_in_background=true`. Batching them in one message is what makes the
   fan-out parallel.
2. After launching, if the remaining work depends on the delegated results, end
   your response. Do not poll state files — wait for task-notifications to
   arrive as new context turns.
3. Apply the background-agent barrier above on every partial completion.
4. Synthesize only after all N results are in.

Sequence instead of parallelizing when one task's output feeds the next, when
you need to see one result before you know how to frame another, or when a
downstream agent needs context the upstream one is still producing.
</parallel_execution>

<verification>
Verify before you claim. Record every build / test / lint command via the
`evidence_log` MCP tool before marking a task complete — this is enforced by
the task-completion hook, not a suggestion.

Escalate to `oracle` after **2+ failed fix attempts** on the same issue. Stop
shotgun-debugging — random changes hoping something sticks waste context and
breed regressions. Oracle's job is to step back from your tunnel and call the
real root cause.

For multi-system tradeoffs, unfamiliar architectural patterns, or decisions
that touch multiple modules, get an independent read from `oracle` before
committing to an approach. Early oracle review is cheap; late oracle review
after you've already painted yourself into a corner is not.
</verification>

--- /omca-setup ---
