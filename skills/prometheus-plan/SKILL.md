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

No task specified → enter interview mode.

Follow prometheus workflow: classify intent, interview, consult metis, generate plan on Claude-native surface, present.

## Plan Mode Awareness

Plan mode allows writing to the native plan file — by design. Native file is authoritative; boulder stores execution pointer only. Both `.omca/plans/` and native plan files coexist.

**Plan mode active** (system context mentions `~/.claude/plans/`):
1. Write to native plan file path — authoritative for this session
2. Copy to `.omca/plans/<name>.md` for boulder tracking (boulder_write after momus approves)
3. ExitPlanMode handled in momus sequence below — NOT here

**Plan mode NOT active**:
- Write to `.omca/plans/<name>.md` (create dir if needed)
- Optionally mirror to `.claude/plans/<name>.md`
- Skip ExitPlanMode

Submit to momus for mandatory review:
`Agent(subagent_type="oh-my-claudeagent:momus", prompt="Review the plan at {plan_path}")`
REJECT → fix all issues, resubmit. Max 3 iterations. Still rejected → present to user.

**After momus OKAY** (only then):
1. `boulder_write(active_plan="/path/to/plan.md", plan_name="plan-name", session_id="current-session")`
   - `.omca/plans/` path when no plan mode; native path when active

2. Ask user via `AskUserQuestion`: "Plan approved by momus. What would you like to do? (you can also type a custom response to modify the plan or stop here)":
   - **"Start implementation"** → Plan mode active: `ExitPlanMode`, guide to `/oh-my-claudeagent:start-work`. Not active: guide to `/oh-my-claudeagent:start-work` or `/oh-my-claudeagent:atlas [plan path]`.
   - **"Run metis review"** → Invoke metis for deeper gap analysis

3. **CRITICAL**: No `ExitPlanMode` or start-work without user choosing "Start implementation". User MUST confirm.
