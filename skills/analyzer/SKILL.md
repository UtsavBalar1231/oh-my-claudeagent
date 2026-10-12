---
name: analyzer
description: Pre-planning analysis via the analyzer. Catches gaps, identifies risks, surfaces hidden requirements.
context: fork
background: false
agent: oh-my-claudeagent:analyzer
user-invocable: true
argument-hint: "[plan file path or request to analyze]"
effort: high
---

Analyze: $ARGUMENTS

$ARGUMENTS accepts either form:

- A **plan file path** (for example a `Status: DRAFT` plan from the planner): read that file and gap-analyze its contents.
- Anything else: treat it as an inline request and gap-analyze the request text itself.

Decide by trying to read it as a path: if `$ARGUMENTS` resolves to a readable file, use the file; otherwise use the text. When nothing is specified, ask the user what to analyze.

Follow analyzer workflow: classify intent, explore codebase for patterns, identify risks and gaps, provide directives for planner.

**Output**: Structured analysis covering hidden intentions, scope boundaries/gaps, risk factors, technical constraints, and actionable planner directives. Feeds directly into the planner.
