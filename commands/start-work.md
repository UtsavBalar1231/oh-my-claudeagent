---
name: start-work
description: Start a work session from a Prometheus-generated plan.
argument-hint: "[plan file] [--worktree <path>]"
---

# Plan Execution Mode — start-work

This command runs in the main session at depth 0. The `Agent` tool is available,
so orchestration is real: parallel fan-out to `executor`, specialist escalation
via `hephaestus`/`explore`/`librarian` as needed. No depth-1 degradation.

## Mandatory MUST REFUSE Clause

This command body runs in the main session at depth 0. If this command somehow
executes in a context where the `Agent` tool is unavailable (subagent depth >= 1,
or stripped by platform), REFUSE and exit immediately.

There is no degraded mode. Do not implement tasks directly. Do not self-review.
Do not attempt a partial execution. Emit the refusal message below and return:

```
ERROR: start-work requires full `Agent`-tool access and was invoked in a context
where the tool is stripped (subagent depth >= 1). There is no degraded-mode
fallback — orchestration and delegation require `Agent`.

Invoke plan execution from the main session via:
  /oh-my-claudeagent:start-work <plan>

Do not call Agent(subagent_type="oh-my-claudeagent:start-work") — that spawns
this command at depth 1 where this error fires.
```

Return immediately after emitting this. No further execution.

## Plan Discovery Logic (Step 0)

### Plan Mode Handling

Plan mode active → call `ExitPlanMode` first. Plugin agents have `permissionMode`
stripped — delegated agents inherit parent session context.

### Finding the Active Plan

1. Check `boulder_progress()` — if `active_plan` points to a valid file with
   unchecked boxes, resume that work directly (skip steps 2-3).

2. No active boulder (or plan fully checked) → search plan surfaces:
   - `~/.claude/plans/*.md` (canonical native plans)
   - `.omca/plans/*.md` (compatibility surface)

3. Merge results, deduplicate by absolute path, label each as `[active]` or
   `[available]`.

### Decision Logic

- **Active boulder AND unchecked boxes** → append session, continue work.
- **No active plan OR plan complete** → list available plans.
  - Single plan found → auto-select.
  - Multiple plans → present list, ask user to choose.

### Argument Handling

If `[plan file]` argument is provided, use that path directly — skip search.

If `--worktree <path>` is provided:
1. Validate: `git rev-parse --show-toplevel` inside path.
2. Valid → store in boulder via `boulder_write`, inject worktree instructions
   into ALL delegation prompts (all ops target worktree paths).
3. Invalid → show setup: `git worktree add <path> <branch>`.

Without `--worktree`:
1. Boulder has `worktree_path` (resume case) → use it.
2. Otherwise → show setup prompt, store via `boulder_write`.

### Boulder Write (BEFORE Delegating)

After plan is selected, BEFORE any delegation:

```
boulder_write(
  active_plan="<absolute path to plan file>",
  plan_name="<plan name>",
  session_id="<current session id>",
  agent="sisyphus"
)
```

`boulder_write` enforces deduplication and preserves `started_at`. Plan body
stays at its authoritative location — boulder stores a pointer only.

### Output Formats

When listing plans for selection:
```
Available Work Plans

Current Time: {ISO timestamp}
Session ID: {current session id}

1. [plan-name-1.md] - Modified: {date} - Progress: 3/10 tasks
2. [plan-name-2.md] - Modified: {date} - Progress: 0/5 tasks

Which plan would you like to work on? (Enter number or plan name)
```

When resuming existing work:
```
Resuming Work Session

Active Plan: {plan-name}
Progress: {completed}/{total} tasks
Worktree: {worktree_path or "not set"}

Reading plan and continuing from last incomplete task...
```

When auto-selecting single plan:
```
Starting Work Session

Plan: {plan-name}
Session: {timestamp} (started)

Reading plan and beginning execution...
```

## Step 1: Register and Analyze

1. `boulder_write(active_plan="<path>", plan_name="<name>", session_id="<current>")` — BEFORE delegating.
2. Read FULL plan file.
3. Parse `- [ ]` checkboxes.
4. Build parallelization map: simultaneous tasks, dependencies, file conflicts.

```
TASK ANALYSIS:
- Total: [N], Remaining: [M]
- Parallelizable Groups: [list]
- Sequential Dependencies: [list]
```

## 6-Section Prompt Structure

Every delegation prompt MUST include ALL 6 sections. Prompts under 30 lines are
typically too thin — include full context.

```markdown
## 1. TASK
[Quote EXACT checkbox item. Be obsessively specific.]

## 2. EXPECTED OUTCOME
- [ ] Files created/modified: [exact paths]
- [ ] Functionality: [exact behavior]
- [ ] Verification: `[command]` passes

## 3. REQUIRED TOOLS
- [tool]: [what to search/check]

## 4. MUST DO
- Follow pattern in [reference file:lines]
- Write tests for [specific cases]

## 5. MUST NOT DO
- Do NOT modify files outside [scope]
- Do NOT add dependencies
- Do NOT skip verification

## 6. CONTEXT
### Dependencies
[What previous tasks built]
```

Example delegation:

```text
Agent(
  subagent_type="oh-my-claudeagent:executor",
  prompt=`[FULL 6-SECTION PROMPT]`
)
```

## Parallel Execution Semantics

### 2.1 Parallelization

Parallel tasks: prepare ALL prompts, invoke in ONE message, wait, verify all.
Sequential tasks: one at a time — real dependency, not comfort.

For exploration agents (always background):
```text
Agent(subagent_type="oh-my-claudeagent:explore", run_in_background=true, ...)
Agent(subagent_type="oh-my-claudeagent:librarian", run_in_background=true, ...)
```

For task execution (never background):
```text
Agent(subagent_type="oh-my-claudeagent:executor", prompt="...", ...)
```

Parallel task group (invoke in ONE message):
```text
// Tasks 2, 3, 4 are independent — invoke together
Agent(subagent_type="oh-my-claudeagent:executor", prompt="Task 2...")
Agent(subagent_type="oh-my-claudeagent:executor", prompt="Task 3...")
Agent(subagent_type="oh-my-claudeagent:executor", prompt="Task 4...")
```

### 2.2 Result Collection

Parallel groups run SYNCHRONOUSLY (multiple Agent calls in one message, NO
`run_in_background`): every tool result returns inline when the batch completes —
read each deliverable directly. Never Read a subagent's `.output`/JSONL transcript
(overflows context), and never re-query a finished agent via `SendMessage` — a
stub return IS the final answer; relaunch a fresh agent with a sharper prompt
instead.

Background (`run_in_background=true`) is reserved for genuine meanwhile-work or
file-based-output skills. Then the deliverable arrives via the Agent tool result
on completion — NOT the `<task-notification>` text (a trigger + output-file path).
While notifications are pending and all remaining work depends on them, acknowledge
briefly, say how many remain, and END the response; synthesize once every tool
result is in. Never act on partial results.

### 2.3 Verify After Every Delegation

```
[ ] Build/typecheck at project level — zero errors
[ ] Build command — exit 0
[ ] Test suite — all pass
[ ] Files exist and match requirements
[ ] No regressions
```

Mark completion immediately: edit plan file `- [ ]` → `- [x]`, then read to
confirm. Do NOT proceed until confirmed.

No evidence = not complete.

## Completeness Check

After flipping the LAST `- [ ]` → `- [x]`:

**Run `just ci`** (full pipeline) and log evidence via `evidence_log`.

Then run a single completeness review. Delegate to `executor`:

```text
Agent(
  subagent_type="oh-my-claudeagent:executor",
  prompt="[6-section completeness review prompt — read plan end-to-end, read diffs,
check each requirement was implemented, check each constraint was honored.
Output: COMPLETE or INCOMPLETE with specifics.]"
)
```

After the review, log the verdict:

```
evidence_log(
  evidence_type="final_verification",
  command="executor: COMPLETE",
  exit_code=0,
  output_snippet="COMPLETE — all requirements met"
)
```

On INCOMPLETE: fix the specific gap, re-run the completeness review, log a fresh
`final_verification` entry. Repeat until COMPLETE.

The Stop hook enforces this gate: it blocks session end when the plan is fully
checked but no `final_verification` evidence entry (exit_code=0) exists. A logged
verdict opens the gate permanently. Set `OMCA_HOOK_DISABLE_FINAL_VERIFY=1` only
in emergencies.

**Do NOT report completion until `final_verification` evidence is logged.**

## Evidence Logging Mandate

Use `evidence_log` after EVERY verification command. The task-completion hook
enforces this — no evidence, no done.

Standard pattern:
```
evidence_log(
  evidence_type="...",
  command="...",
  exit_code=0,
  output_snippet="...",
  verified_by="executor"
)
```

Completeness-check evidence call:

```
evidence_log(
  evidence_type="final_verification",
  command="executor: COMPLETE",
  exit_code=0,
  output_snippet="COMPLETE — all N requirements met, no constraints violated"
)
```

Evidence type table:

| Type                 | When                                          |
|----------------------|-----------------------------------------------|
| `build`              | Build/compile command                         |
| `test`               | Test suite run                                |
| `lint`               | Linter or static analysis                     |
| `manual`             | Manual QA scenario                            |
| `final_verification` | End-of-plan completeness verdict (COMPLETE)   |

Session end is blocked until a `final_verification` entry with `exit_code=0` exists.

## Auto-Continue Policy

NEVER ask "should I continue" between plan steps. After verification passes →
immediately delegate next task.

**Pause only when**: plan needs clarification, blocked by external dependency,
critical failure.

### Stop Conditions

| Condition    | Signal                                                | Action                                             |
|--------------|-------------------------------------------------------|-----------------------------------------------------|
| **CONTINUE** | Task passes verification AND subsequent tasks unblocked | Proceed immediately                              |
| **ESCALATE** | 2+ tasks in same plan area fail verification          | Ask user whether to run metis re-analysis          |
| **PAUSE**    | 2 consecutive independent task failures               | Document failures, pause, ask user for guidance    |
| **ABORT**    | 3+ consecutive waves with zero net progress           | Stop all work, document state, present to user     |

### Failure Handling

Max 3 retries per task. Blocked after 3 → `notepad_write(plan_name, "issues", ...)`,
continue to independent tasks. After 2+ tasks in same area fail → ask user
whether to run metis re-analysis.

## MCP Tool Reference

- **`boulder_write`**: Write/update execution metadata (active plan, session ID, worktree path)
- **`boulder_progress`**: Task completion counts and active plan info
- **`evidence_log`**: After EVERY verification command — enforced by task-completion hook
- **`evidence_read`**: Before final report to summarize all results
- **`notepad_write`**: Blockers/audit breadcrumbs (learnings, issues, decisions, problems)
- **`notepad_read`**: Fallback audit notes when relevant to a pending task
- Never `rm -f` on `.omca/state/` — use MCP tools

## Critical Rules

- `boulder_write` BEFORE delegating — tracks execution metadata
- Read FULL plan before delegating
- All 6 sections in every delegation prompt
- `evidence_log` after EVERY verification command — task-completion hook enforces this
- `evidence_read` before final report to summarize all results
- Mark plan checkboxes immediately after verification — do NOT batch
- Never trust subagent claims without independent verification
- Never batch multiple plan tasks in one delegation
- Never use `Bash(claude ...)` — use native `Agent(subagent_type=...)`
