---
name: atlas
description: Execute work plans via the Atlas orchestrator. Delegates all tasks, verifies results.
context: fork
agent: oh-my-claudeagent:atlas
user-invocable: true
argument-hint: "[plan file or task description]"
---

Execute the following: $ARGUMENTS

**When to use this vs `/sisyphus-orchestrate`**: Use atlas when you have a structured plan
(from prometheus) with checkboxed tasks. Use `/sisyphus-orchestrate` for open-ended work
where the plan emerges during execution.

If no task was specified, find plans by priority:
1. Check boulder state via `boulder_read` — if an active plan exists, resume it
2. Search `.omca/plans/*.md` for plugin-generated plans
3. Search `~/.claude/plans/*.md` for Claude Code native plan mode plans
4. Merge and present both lists for selection, labeled with source

Register the active plan before delegating:
`boulder_write(active_plan="path/to/plan.md", plan_name="plan-name", session_id="current-session")`

Use `boulder_read` and `boulder_progress` tools to check current state.
Follow atlas workflow: analyze plan, delegate tasks via sisyphus-junior, verify each result,
mark checkboxes on completion.

After each delegation verification, record evidence:
`evidence_record(evidence_type="test", command="...", exit_code=0, output_snippet="...")`

Use `omca_notepad_write(plan_name, "issues", content)` to record blockers or unexpected findings.
Use `evidence_read` before final completion report to summarize all verification results.
