---
name: prometheus-plan
description: Strategic planning via the Prometheus consultant. Interviews, researches, and generates structured work plans.
context: fork
agent: oh-my-claudeagent:prometheus
user-invocable: true
argument-hint: "[feature or task to plan]"
---

Create a work plan for: $ARGUMENTS

If no task was specified above, enter interview mode to understand what needs to be planned.

Follow the prometheus workflow: classify intent complexity, conduct requirements interview,
consult metis for gap analysis, generate the plan to `.omca/plans/`, and present the plan.

**Handoff**: After plan completion, guide the user:
1. **Primary**: "Run `/oh-my-claudeagent:start-work` to execute this plan (handles plan discovery, boulder setup, worktree)."
2. **Alternative**: "Or run `/oh-my-claudeagent:atlas [plan path]` for direct atlas execution."

Both fork atlas at depth 0. Recommend `/start-work` first — it adds boulder/worktree setup on top of atlas orchestration.

After generating the plan, submit to momus for mandatory review:
`Agent(subagent_type="oh-my-claudeagent:momus", prompt="Review the plan at {plan_path}")`
If momus returns REJECT, fix all issues and resubmit. Maximum 3 iterations.
If still REJECTED after 3: Present plan + momus feedback to user, ask for direction.

After saving the plan file, register it as the active boulder:
`boulder_write(active_plan="/path/to/plan.md", plan_name="plan-name", session_id="current-session")`
This ensures hooks and subagents can discover the active plan via boulder_read.
