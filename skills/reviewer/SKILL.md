---
name: reviewer
description: Rigorous plan review via the reviewer. Validates clarity, verifiability, and completeness before execution; returns OKAY or REJECT.
context: fork
background: false
agent: oh-my-claudeagent:reviewer
user-invocable: true
argument-hint: "[plan file path]"
effort: high
---

Review the work plan at: $ARGUMENTS

Require one unambiguous plan file path, not an inline summary. Ask for it when
missing. Apply the reviewer's instructions and return OKAY or REJECT with
concrete blockers, source references and the smallest corrections.
