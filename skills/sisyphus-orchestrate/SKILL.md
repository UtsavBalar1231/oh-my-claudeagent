---
name: sisyphus-orchestrate
description: Master orchestration via Sisyphus. Delegates to specialists, coordinates parallel execution, verifies everything.
context: fork
agent: oh-my-claudeagent:sisyphus
user-invocable: true
disable-model-invocation: true
argument-hint: "[task description]"
---

Execute the following: $ARGUMENTS

If no task was specified above, ask the user what they would like to accomplish.

Follow the sisyphus workflow: classify intent, assess codebase, delegate to specialist
agents, coordinate parallel execution, verify results. Use task tracking for multi-step
work.
