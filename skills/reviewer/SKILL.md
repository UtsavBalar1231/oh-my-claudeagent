---
name: reviewer
description: Rigorous plan review via the reviewer. Validates clarity, verifiability, and completeness before execution; returns OKAY or REJECT.
context: fork
agent: oh-my-claudeagent:reviewer
user-invocable: true
argument-hint: "[plan file path]"
effort: high
---

Review the work plan at: $ARGUMENTS

Require one unambiguous plan file path, not an inline summary. Ask for it when
missing. Text after the path, when present, is the plan's tasks: judge it together
with the file. Apply the reviewer's instructions and return OKAY or REJECT with
concrete blockers, source references and the smallest corrections.
