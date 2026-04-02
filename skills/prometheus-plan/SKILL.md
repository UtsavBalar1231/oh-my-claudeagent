---
name: prometheus-plan
description: Strategic planning via the Prometheus consultant. Interviews, researches, and generates structured work plans.
context: fork
agent: oh-my-claudeagent:prometheus
user-invocable: true
argument-hint: "[feature or task to plan]"
shell: bash
effort: high
---

Create a work plan for: $ARGUMENTS

If no task was specified above, enter interview mode to understand what needs to be planned.

Follow the prometheus workflow: classify intent complexity, conduct requirements interview,
consult metis for gap analysis, generate the plan on the Claude-native planning surface,
and present the plan.

## Plan Mode Awareness

**Why prometheus can write in plan mode**: Plan mode allows writing to the native plan file path
Claude provides — this is by design. That native plan file is authoritative, while
`.omca/state/boulder.json` only tracks execution metadata. The `Edit` tool on the plan file is
explicitly permitted in plan mode.

Both `.omca/plans/` and native plan files are valid. They coexist — neither replaces the other.

If plan mode is active (detectable from system context mentioning a plan file at `~/.claude/plans/`):
1. Write the plan to the native plan file path from the plan mode context — that is the authoritative copy for this session
2. Also write a copy to `.omca/plans/<name>.md` so boulder tracking works (boulder_write requires a file path)
3. ExitPlanMode is called as part of the momus completion sequence below — NOT here

If plan mode is NOT active:
- Write the plan to `.omca/plans/<name>.md` (create `.omca/plans/` if needed) — this is the primary output location
- Optionally mirror to `.claude/plans/<name>.md` if the user prefers Claude-native plan surfacing
- Skip ExitPlanMode (not applicable)

**Handoff**: After plan completion, guide the user:
1. **Primary**: "Run `/oh-my-claudeagent:start-work` to execute this plan (handles plan discovery, boulder setup, worktree)."
2. **Alternative**: "Or run `/oh-my-claudeagent:atlas [plan path]` for direct atlas execution."

Both fork atlas at depth 0. Recommend `/start-work` first — it adds boulder/worktree setup on top of atlas orchestration.

After generating the plan, submit to momus for mandatory review:
`Agent(subagent_type="oh-my-claudeagent:momus", prompt="Review the plan at {plan_path}")`
If momus returns REJECT, fix all issues and resubmit. Maximum 3 iterations.
If still REJECTED after 3: Present plan + momus feedback to user, ask for direction.

**After momus returns OKAY** (and ONLY then):
1. Register as active boulder: `boulder_write(active_plan="/path/to/plan.md", plan_name="plan-name", session_id="current-session")`
   - Use the `.omca/plans/<name>.md` path when plan mode is not active
   - Use the native plan file path when plan mode is active (boulder just stores a pointer)
2. If plan mode is active: call `ExitPlanMode` to present the plan for user approval
3. If plan mode is NOT active: guide user to `/oh-my-claudeagent:start-work`
