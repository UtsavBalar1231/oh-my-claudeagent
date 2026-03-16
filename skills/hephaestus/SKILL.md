---
name: hephaestus
description: Fix build failures, type errors, and toolchain issues via the Hephaestus build-fixer.
context: fork
agent: oh-my-claudeagent:hephaestus
user-invocable: true
argument-hint: "[build command or error description]"
---

Fix the following build issue: $ARGUMENTS

If no specific issue was provided above, run the project's build command to discover
current failures, then diagnose and fix them.

Follow the hephaestus workflow: reproduce the failure, diagnose root cause, make minimal
fixes, verify the build passes. Repeat until exit code 0.

After the build passes, record verification evidence:
`evidence_record(type="build", command="<build command>", exit_code=0, output_snippet="<relevant output>")`
