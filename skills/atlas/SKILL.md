---
name: atlas
description: Execute work plans via the Atlas orchestrator. Delegates all tasks, verifies results.
context: fork
agent: oh-my-claudeagent:atlas
user-invocable: true
argument-hint: "[plan file or task description]"
shell: bash
effort: high
---

Execute the following: $ARGUMENTS

**vs `/sisyphus-orchestrate`**: Use atlas with a structured plan (from prometheus) with checkboxed tasks. Use `/sisyphus-orchestrate` for open-ended work where the plan emerges during execution.

No task specified → find plans by priority:
1. `mode_read` — active plan exists → resume it
2. Search `.omca/plans/*.md` and `.claude/plans/*.md`
3. Merge candidates, deduplicated by path, labeled `[omca]` or `[native]`

Register before delegating:
`boulder_write(active_plan="path/to/plan.md", plan_name="plan-name", session_id="current-session")`

Use `mode_read` and `boulder_progress` to check state. Follow atlas workflow: analyze plan, delegate via sisyphus-junior, verify, mark checkboxes.

After each verification, record evidence:
`evidence_log(evidence_type="test", command="...", exit_code=0, output_snippet="...")`

`notepad_write(plan_name, "issues", content)` for blockers/audit breadcrumbs. Not primary working memory.
`evidence_read` before final report to summarize all results.
