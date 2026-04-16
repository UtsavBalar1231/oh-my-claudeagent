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

No request specified → ask the user what to analyze.

Follow metis workflow: classify intent, explore codebase for patterns, identify risks and gaps, provide directives for planner.

**Output**: Structured analysis — hidden intentions, scope boundaries/gaps, risk factors, technical constraints, actionable planner directives. Feeds directly into prometheus.
