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

When no issue is specified, run the build command to discover failures, then diagnose and fix.

Build-fixer workflow: reproduce, diagnose root cause, minimal fix, verify build passes. Repeat until exit 0.

After build passes, record evidence:
`evidence_log(evidence_type="build", command="<build command>", exit_code=0, output_snippet="<relevant output>")`
