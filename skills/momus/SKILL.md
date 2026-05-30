---
name: momus
description: Rigorous plan review via the Momus consultant. Validates clarity, verifiability, and completeness before execution; returns OKAY or REJECT.
context: fork
agent: oh-my-claudeagent:momus
user-invocable: true
argument-hint: "[plan file path]"
effort: high
---

Review the work plan at: $ARGUMENTS

No path specified → ask the user for the plan file path. Accept a FILE PATH only — not an inline plan, todo list, or text summary.

Follow momus workflow: read the plan, deep-verify every file reference, apply the five evaluation criteria, run falsification on the 2 most critical tasks, and return the Final Verdict (OKAY / REJECT with confidence, justification, and priority-tiered issues).

**Output**: A single OKAY/REJECT verdict in the Final Verdict Format defined in `agents/momus.md`. This feeds the prometheus review loop.
