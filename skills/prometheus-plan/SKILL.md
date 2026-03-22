---
name: prometheus-plan
description: Strategic planning via the Prometheus consultant. Interviews, researches, and generates structured work plans.
context: fork
agent: oh-my-claudeagent:prometheus
user-invocable: true
argument-hint: "[feature or task to plan]"
effort: high
---

Create a work plan for: $ARGUMENTS

If no task was specified above, enter interview mode to understand what needs to be planned.

Follow the prometheus workflow: classify intent complexity, conduct requirements interview,
consult metis for gap analysis, generate the plan to `.omca/plans/`, and present the plan.

## Plan Mode Awareness

**Why prometheus can write in plan mode**: Plan mode allows writing to the native plan file path
(`~/.claude/plans/<name>.md`) — this is by design. Prometheus also writes to `.omca/plans/` which
is the plugin's state directory. The `Edit` tool on the plan file is explicitly permitted in plan mode.

If plan mode is active (detectable from system context mentioning a plan file at `~/.claude/plans/`):
1. Write the plan to BOTH locations:
   - The native plan file path from the plan mode context (`~/.claude/plans/<name>.md`) — **presentation copy** for plan mode UI
   - The standard `.omca/plans/<name>.md` location — **authoritative copy** for atlas/boulder execution
2. ExitPlanMode is called as part of the momus completion sequence below — NOT here

If plan mode is NOT active:
- Write the plan to `.omca/plans/` only (existing behavior)
- Skip ExitPlanMode (not applicable)

**Handoff**: After plan completion, guide the user:
1. **Primary**: "Run `/oh-my-claudeagent:start-work` to execute this plan (handles plan discovery, boulder setup, worktree)."
2. **Alternative**: "Or run `/oh-my-claudeagent:atlas [plan path]` for direct atlas execution."

Both fork atlas at depth 0. Recommend `/start-work` first — it adds boulder/worktree setup on top of atlas orchestration.

After generating the plan, submit to momus for mandatory review:
`Agent(subagent_type="oh-my-claudeagent:momus", prompt="Review the plan at {plan_path}")`
If momus returns REJECT, fix all issues and resubmit. Maximum 3 iterations.
If still REJECTED after 3: Present plan + momus feedback to user, ask for direction.

**After momus returns OKAY** (and ONLY then):
1. Register as active boulder: `boulder_write(active_plan="/path/to/plan.md", plan_name="plan-name", session_id="current-session")`
2. If plan mode is active: call `ExitPlanMode` to present the plan for user approval
3. If plan mode is NOT active: guide user to `/oh-my-claudeagent:start-work`
