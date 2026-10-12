---
name: plan
description: Create a strategic work plan via a planner-style interview and structured plan drafting.
user-invocable: true
disable-model-invocation: true
argument-hint: "[work description]"
---

Call `health_check` first, loading it if needed: `ToolSearch({query: "select:mcp__plugin_oh-my-claudeagent_omca__health_check", max_results: 1})`. Proceed only when `runtime` is `ok`; otherwise repeat `runtime_reason` to the user, tell them to run `/oh-my-claudeagent:omca-setup`, and stop. If the tool is still missing, say OMCA's server is not connected and stop.

# Plan command: planner entrypoint

Invoke the planner protocol at depth 0, in this session. Run the protocol yourself rather than handing the plan to a `planner` subagent: a subagent runs without `AskUserQuestion`, and in a headless run its result may not land. User provides work description via `$ARGUMENTS`.

## Protocol

Follow `${CLAUDE_PLUGIN_ROOT}/agents/planner.md` end-to-end:

**Phase 1: Interview**: Route on outcome clarity FIRST (CLEAR / UNCLEAR / ON-THE-FENCE, planner.md Step 0); UNCLEAR skips the interview and applies announced defaults instead. Classify work intent (trivial/simple/complex/build/refactor/architecture/research). Apply Simple Request Detection. Run Exploration Gate: mandatory for Build from Scratch, Research, Architecture; scoped for Refactoring; skip for Trivial. Once exploration returns and before interviewing, write the plan file with `**Status**: DRAFT` on its metadata line, numbered `- [ ] N.` tasks from that first write (the plan-write validator denies a plan `Write` that has a `## TODOs` or `## Work Objectives` heading and no numbered task), and an `## Open questions` section carrying a stated default per question. Interview against that file: the user corrects something concrete instead of answering abstract questions, so the interview gets shorter, not longer. Use `AskUserQuestion` for targeted interview questions; fall back to `## BLOCKING QUESTIONS` block if unavailable. Run Self-Clearance Check after every interview turn. When every applicable checklist item is YES, auto-transition. When any item is NO, ask the specific unclear question.

**Phase 2, Plan Generation**: Consult the analyzer on the DRAFT, then update the plan in place to `**Status**: FINAL`. Do not call `boulder_write`: `/oh-my-claudeagent:start-work` registers the plan and binds the session that executes it. Write plan to `<plans-dir>/{name}.md` or the active plan-mode file. `<plans-dir>` is the `plansDirectory` setting when set (relative to the project root), otherwise `~/.claude/plans`. Resolve it from settings instead of assuming the default, or the plan lands where nothing looks for it. Enforce task checkboxes (`- [ ] N.`). Run the reviewer review loop by invoking the `oh-my-claudeagent:reviewer` skill (via the Skill tool) with the plan file path, max 3 iterations until OKAY.

**Phase 3, Handoff**: After reviewer OKAY, confirm next steps with user via `AskUserQuestion`. Guide to `/oh-my-claudeagent:start-work` for execution.

## Delegation

Delegate exploration to `explorer` agents (parallel when topics are independent). Delegate external research to `researcher`. Implementation belongs to `/oh-my-claudeagent:start-work`; this command neither implements nor delegates implementation.

A subagent's deliverable arrives in the `<result>` block of its `<task-notification>`, or as the Agent tool's return value where the platform ran it in the foreground; those are the only two places a result exists, so never claim a result you have not received in one of them. While an agent is outstanding, carry on with work that does not overlap what it was asked to do.
Do not read or tail the agent's output file: for a subagent it is the full JSONL transcript rather than a plain result, and reading it will overflow your context. The OMCA Default output style carries the full statement of this, under "Fan-out".

## Constraints

- Planner only. No code. No task execution.
- Single deliverable plan regardless of size.
- Plans always in English.

## Research and think-it-through requests

When the user wants to understand or research something rather than get a work plan ("help me understand X", "research Z", or an explicit ask to talk it through), the planner runs its interview-only dialogue before Phase 1. It asks questions that surface hidden constraints and clarify the problem through iterative dialogue, then returns a synthesis. It writes no plan file in this case. An underspecified request that does want a plan goes through the planner's outcome-clarity routing instead, which researches and announces defaults rather than handing the outcome back to the user.
