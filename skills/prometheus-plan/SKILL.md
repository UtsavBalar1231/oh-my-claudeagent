---
name: prometheus-plan
description: Strategic planning via the Prometheus consultant. Interviews, researches, and generates structured work plans.
context: fork
agent: oh-my-claudeagent:prometheus
user-invocable: true
disable-model-invocation: true
argument-hint: "[feature or task to plan]"
---

Create a work plan for: $ARGUMENTS

If no task was specified above, enter interview mode to understand what needs to be planned.

Follow the prometheus workflow: classify intent complexity, conduct requirements interview,
consult metis for gap analysis, generate the plan to `.omca/plans/`, and guide the user
to `/oh-my-claudeagent:start-work` or `/oh-my-claudeagent:atlas` for execution.
