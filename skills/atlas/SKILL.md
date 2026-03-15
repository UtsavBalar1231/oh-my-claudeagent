---
name: atlas
description: Execute work plans via the Atlas orchestrator. Delegates all tasks, verifies results.
context: fork
agent: oh-my-claudeagent:atlas
user-invocable: true
disable-model-invocation: true
argument-hint: "[plan file or task description]"
---

Execute the following: $ARGUMENTS

**When to use this vs `/sisyphus-orchestrate`**: Use atlas when you have a structured plan
(from prometheus) with checkboxed tasks. Use `/sisyphus-orchestrate` for open-ended work
where the plan emerges during execution.

If no task was specified above, list available plans from `.omca/plans/` and present them
for selection. If `.omca/state/boulder.json` exists with an active incomplete plan, show
its progress and offer to resume.

Use `boulder_read` and `boulder_progress` tools to check current state.
Follow atlas workflow: analyze plan, delegate tasks via sisyphus-junior, verify each result,
mark checkboxes on completion.

After each delegation verification, record evidence:
`evidence_record(type="test", command="...", exit_code=0, output_snippet="...")`

Use `omca_notepad_write(plan_name, "issues", content)` to record blockers or unexpected findings.
Use `evidence_read` before final completion report to summarize all verification results.
