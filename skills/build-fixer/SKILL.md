---
name: build-fixer
description: "Use when a build, type check or dependency install fails, or the user pastes a compiler error or says \"fix build\". Runs the build-fixer agent."
context: fork
background: false
agent: oh-my-claudeagent:build-fixer
user-invocable: true
argument-hint: "[build command or error description]"
effort: medium
disallowed-tools: [Agent]
---

Fix the following build issue: $ARGUMENTS

If the input is empty, find the documented build command and reproduce its
failure. Apply the build-fixer's instructions and return its evidence and any
unresolved blockers.
