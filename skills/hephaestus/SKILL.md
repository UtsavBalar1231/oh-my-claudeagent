---
name: hephaestus
description: Specialist agent that fixes build failures, type errors, and toolchain issues.
when_to_use: |
  Use when:
  - A build or compile step is failing
  - Type errors are blocking progress
  - Dependency or toolchain issues need diagnosis
  - User says "fix build", "build broken", or pastes a compiler error
context: fork
agent: oh-my-claudeagent:hephaestus
user-invocable: true
argument-hint: "[build command or error description]"
effort: medium
---

Fix the following build issue: $ARGUMENTS

No issue specified → run the build command to discover failures, then diagnose and fix.

Hephaestus workflow: reproduce, diagnose root cause, minimal fix, verify build passes. Repeat until exit 0.

After build passes, record evidence:
`evidence_log(evidence_type="build", command="<build command>", exit_code=0, output_snippet="<relevant output>")`
