---
name: metis
description: Pre-planning analysis via the Metis consultant. Catches gaps, identifies risks, surfaces hidden requirements.
context: fork
agent: oh-my-claudeagent:metis
user-invocable: true
argument-hint: "[request to analyze]"
---

Analyze the following request: $ARGUMENTS

If no request was specified above, ask the user what they would like analyzed before
proceeding to planning.

Follow the metis workflow: classify intent, explore the codebase for relevant patterns,
identify risks and gaps, provide actionable directives for the planner.
