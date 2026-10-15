---
name: refactor
description: Use when restructuring code without changing its behavior, such as extracting a module or migrating off an API. Maps the affected code, plans the steps, and runs the tests after each change.
user-invocable: true
argument-hint: "[target file or module]"
effort: high
---

# Refactor

Preserve behavior while restructuring the requested target. Establish scope and intent before editing; ask about materially different interpretations. Accept a file, symbol, or pattern, such as "all functions using deprecated API". Default to module scope and a safe strategy; honor `--scope=file|module|project` and `--strategy=safe|aggressive` without treating aggressive as permission to change behavior.

Map definitions, callers, imports, and tests. Run a baseline; if behavior lacks coverage, propose characterization tests before restructuring and refuse aggressive changes until that coverage exists. For project-wide investigations, delegate independent search areas only if the current role permits it. Leaf workers search directly.

Plan small, independently verifiable steps in dependency order, with file targets and a way to undo each step. Use `ast_search` for structural references and preview `ast_replace` with `dry_run` before applying. Read version-matched documentation for a requested API migration.

Run affected tests and typechecks after each step. Do not continue past a failure, suppress type errors, or weaken tests to get green. Undo only your failing step without discarding others' work, then diagnose from the recorded failure. Finish with the project's relevant build, lint, and regression checks. Record every run with `evidence_log` and its real exit code; report any unverified behavior.

## Deprecated Code & Library Migration

Do not upgrade dependencies or migrate APIs unasked. For a requested migration, consult official documentation or `oh-my-claudeagent:researcher` for the supported alternative before editing.

## Claude Code

If owner decisions require an interview, ask the user to run `/oh-my-claudeagent:plan`. Do not spawn a planner child that cannot ask the user questions.
