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

**When to use this vs `/sisyphus-orchestrate`**: Use atlas when you have a structured plan
(from prometheus) with checkboxed tasks. Use `/sisyphus-orchestrate` for open-ended work
where the plan emerges during execution.

If no task was specified, find plans by priority:
1. Check boulder state via `mode_read` — if an active plan exists, resume it
2. Search both plan locations:
   - `.omca/plans/*.md` — prometheus-generated plans
   - `.claude/plans/*.md` — Claude-native plan files
3. Merge and present candidates for selection, deduplicated by absolute path, labeled with source (`[omca]` or `[native]`)

Register the active plan before delegating:
`boulder_write(active_plan="path/to/plan.md", plan_name="plan-name", session_id="current-session")`

Use `mode_read` and `boulder_progress` tools to check current state.
Follow atlas workflow: analyze plan, delegate tasks via sisyphus-junior, verify each result,
mark checkboxes on completion.

After each delegation verification, record evidence:
`evidence_log(evidence_type="test", command="...", exit_code=0, output_snippet="...")`

Use `notepad_write(plan_name, "issues", content)` to record blockers or audit breadcrumbs that need to survive handoff. Do not treat notepad as your primary working memory.
Use `evidence_read` before final completion report to summarize all verification results.
