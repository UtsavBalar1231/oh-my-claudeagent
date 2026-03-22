---
name: sisyphus-orchestrate
description: Master orchestration via Sisyphus. Delegates to specialists, coordinates parallel execution, verifies everything.
context: fork
agent: oh-my-claudeagent:sisyphus
user-invocable: true
argument-hint: "[task description]"
effort: high
---

Execute the following: $ARGUMENTS

If no task was specified above, ask the user what they would like to accomplish.

**When to use this vs `/atlas`**: Use sisyphus-orchestrate for open-ended, adaptive tasks
where the work plan emerges during execution. Use `/atlas` when you already have a
structured plan (from prometheus) with checkboxed tasks to execute.

Follow the sisyphus workflow: classify intent, assess codebase, delegate to specialist
agents, coordinate parallel execution, verify results. Use task tracking for multi-step
work.

## Plan Mode Compatibility

Sisyphus does NOT set `permissionMode` (it respects the user's choice as the default agent).
If invoked during plan mode, sisyphus inherits plan mode restrictions and cannot execute.

**Workaround**: Exit plan mode first (Shift+Tab or approve the plan), then invoke `/sisyphus-orchestrate`.
Or use `/start-work` instead — atlas has `permissionMode: acceptEdits` and can execute from plan mode.
