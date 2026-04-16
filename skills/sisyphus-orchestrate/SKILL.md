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

No task specified → ask the user what to accomplish.

**vs `/atlas`**: Use sisyphus-orchestrate for open-ended work where the plan emerges during execution. Use `/atlas` with a structured plan (from prometheus) with checkboxed tasks.

Follow sisyphus workflow: classify intent, assess codebase, delegate to specialists, coordinate parallel execution, verify results. Task tracking for multi-step work.

## Plan Mode Compatibility

Plugin agents have `permissionMode` stripped — sisyphus cannot override. During plan mode, inherits restrictions and cannot execute.

**Workaround**: Exit plan mode first (Shift+Tab or approve), then `/sisyphus-orchestrate`. Or use `/start-work` — calls `ExitPlanMode` before atlas.
