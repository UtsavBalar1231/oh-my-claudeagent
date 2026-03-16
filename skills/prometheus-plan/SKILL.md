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
1. **Primary**: "Run `/oh-my-claudeagent:atlas` to execute this plan via the atlas orchestrator."
2. **Alternative**: "Or run `/oh-my-claudeagent:start-work` for manual plan-guided execution."

Always recommend `/atlas` first — it provides full orchestration with delegation, verification, and progress tracking.

After saving the plan file, register it as the active boulder:
`boulder_write(active_plan="/path/to/plan.md", plan_name="plan-name", session_id="current-session")`
This ensures hooks and subagents can discover the active plan via boulder_read.
