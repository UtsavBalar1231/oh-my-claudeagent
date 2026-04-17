---
name: start-work
description: Start a work session from a Prometheus-generated plan.
user-invocable: true
argument-hint: "[plan file] [--worktree <path>]"
shell: bash
effort: high
---

# Start Work Session

This skill runs in the main session at depth 0. The `Agent` tool is available, so orchestration is real: parallel fan-out to `executor`, independent F1 via `oracle`, specialist escalation via `hephaestus`/`explore`/`librarian` as needed. No depth-1 degradation.

Start executing a Prometheus-generated plan.

## Plan Mode Handling (Step 0)

Plan mode active → call `ExitPlanMode` first. Plugin agents have `permissionMode` stripped — delegated agents inherit parent session context.

## What To Do

1. **Find plans** (both surfaces valid):
   a. `mode_read(mode="boulder")` — active `active_plan` pointing to valid file → use directly
   b. No active boulder → search `.omca/plans/*.md` and `.claude/plans/*.md`
   c. Merge, deduplicate by absolute path, label `[active]`/`[omca]`/`[native]`

2. **Check execution metadata**: `mode_read(mode="boulder")`

3. **Decision logic**:
   - Active boulder AND unchecked boxes → append session, continue work
   - No active plan OR complete → list plans. One → auto-select. Multiple → ask user.

4. **Boulder state** (use `boulder_write` MCP tool, never hand-edit):
   ```json
   {
     "active_plan": "/absolute/path/to/plan.md",
     "started_at": "ISO_TIMESTAMP",
     "session_ids": ["session_id_1", "session_id_2"],
     "plan_name": "plan-name",
     "worktree_path": "/absolute/path/to/worktree"
   }
   ```
   `boulder_write` enforces deduplication and preserves `started_at`. Plan body stays at authoritative location — boulder stores pointer only.

5. **Read plan** and execute via the orchestration protocol below.

## Worktree Support

### `--worktree <path>` provided:
1. Validate: `git rev-parse --show-toplevel` inside path
2. Valid → store in boulder via `boulder_write`, inject worktree instructions:
   - ALL operations target worktree paths (read, write, edit, git)
   - Include worktree path in delegation prompts
   - NEVER operate on main repo directory
3. Invalid → show setup: `git worktree add <path> <branch>`

### No `--worktree`:
1. Boulder has `worktree_path` (resume) → use it
2. Otherwise → show setup prompt, store via `boulder_write`

### Resume with existing worktree:
Show existing path. New `--worktree` → update via `boulder_write`.

## Output Format

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
Sessions: {count} (appending current session)

Reading plan and continuing from last incomplete task...
```

When auto-selecting single plan:
```
Starting Work Session

Plan: {plan-name}
Session: {timestamp} (started)
Started: {timestamp}

Reading plan and beginning execution...
```

## Execute Plan

This skill runs inline in the main session at depth 0 — the `Agent` tool is always available. No pre-flight probe, no degraded-mode fallback. If you ever see evidence that this is running at subagent depth ≥ 1, stop and report: you are in the wrong context.


### Step 1: Register and Analyze

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

### Step 2: Execute Tasks

#### 2.1 Parallelization

Parallel: prepare ALL prompts, invoke in ONE message, wait, verify all.
Sequential: one at a time.

#### 2.2 Invoke Delegation — 6-Section Prompt Structure

Every delegation prompt MUST include ALL 6 sections:

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

Prompts under 30 lines are typically too thin — include full context.

```text
Agent(
  subagent_type="oh-my-claudeagent:executor",
  prompt=`[FULL 6-SECTION PROMPT]`
)
```

For exploration: `Agent(subagent_type="oh-my-claudeagent:explore", run_in_background=true, ...)`
For task execution: do NOT use `run_in_background=true`.

#### 2.3 Verify

After EVERY delegation:

```
[ ] Build/typecheck at project level — zero errors
[ ] Build command — exit 0
[ ] Test suite — all pass
[ ] Files exist and match requirements
[ ] No regressions
```

Mark completion immediately: edit plan file `- [ ]` → `- [x]`, then read to confirm.

`evidence_log(evidence_type="...", command="...", exit_code=0, output_snippet="...", plan_sha256="<sha256>", verified_by="executor")`

#### 2.4 Handle Failures

Max 3 retries per task. Blocked after 3 → document in notepad `issues`, continue to independent tasks. After 2+ tasks in same area fail → ask user whether to run metis re-analysis.

#### 2.5 Background Agent Barrier

When N background agents launched and first completes: acknowledge, say "Waiting for N more...", END response. Synthesize only after all N results arrive.

#### 2.6 Loop Until Done

### Step 3: Final Verification Wave (MANDATORY — after ALL plan tasks complete)

Write `STATE_DIR/pending-final-verify.json` after flipping last `- [ ]` → `- [x]`, BEFORE F1-F4:

```json
{
  "plan_path": "<absolute path>",
  "plan_sha256": "<hex digest of frozen plan>",
  "marked_at": <unix timestamp>,
  "session_id": "<CLAUDE_SESSION_ID>"
}
```

Spawn 4 review agents. ALL must APPROVE. Present results, get explicit user "okay" before completion.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  `Agent(subagent_type="oh-my-claudeagent:oracle", prompt="[6-section prompt with F1 review scope]")`
  Output: `Requirements [N/N] | Constraints [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `executor`
  `Agent(subagent_type="oh-my-claudeagent:executor", prompt="[6-section prompt with F2 details]")`
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Manual QA** — `executor`
  Output: `Scenarios [N/N pass] | Integration [N/N] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `executor`
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | VERDICT`

Log each F-step immediately after verdict:
```
evidence_log(evidence_type="final_verification_f1", command="oracle: APPROVE", exit_code=0, plan_sha256="<hex>", output_snippet="plan_sha256:<hex> verdict:APPROVE")
```

After ANY REJECT: fix issues, re-run that reviewer only. After ALL 4 APPROVE: present results, get explicit user "okay", then report completion.

## Critical

- `boulder_write` BEFORE delegating — tracks execution metadata
- Read FULL plan before delegating
- All 6 sections in every delegation prompt
- `evidence_log` after EVERY verification command — task-completion hook enforces this
- `notepad_write(plan_name, "issues", content)` for blockers/audit breadcrumbs
- `evidence_read` before final report to summarize all results
