---
name: metis
description: Pre-planning analysis via the Metis consultant. Catches gaps, identifies risks, surfaces hidden requirements.
context: fork
agent: oh-my-claudeagent:metis
user-invocable: true
argument-hint: "[request to analyze]"
effort: high
---

Analyze the following request: $ARGUMENTS

If no request was specified above, ask the user what they would like analyzed before
proceeding to planning.

Follow the metis workflow: classify intent, explore the codebase for relevant patterns,
identify risks and gaps, provide actionable directives for the planner.

**Expected output**: Metis produces a structured analysis covering: hidden intentions behind the request, scope boundaries and gaps, risk factors, technical constraints, and actionable directives for the planner. This output feeds directly into prometheus for plan generation.
