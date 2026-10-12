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

When no path is specified, ask the user for the plan file path. Accept a FILE PATH only, not an inline plan, todo list, or text summary.

Follow reviewer workflow: read the plan, deep-verify every file reference, apply the five evaluation criteria, run falsification on the 2 most critical tasks, and return the Final Verdict (OKAY / REJECT with confidence, justification, and priority-tiered issues).

Output: A single OKAY/REJECT verdict in the Final Verdict Format defined in `${CLAUDE_PLUGIN_ROOT}/agents/reviewer.md`. This feeds the planner review loop.
