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

Read the target if it is a readable plan path; otherwise analyze it as a request.
Ask what to analyze when the input is empty. Apply the analyzer's instructions
and return concrete gaps, evidence and unresolved decisions. Do not implement.
