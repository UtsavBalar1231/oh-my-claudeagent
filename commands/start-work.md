---
name: start-work
description: Start a work session from a Prometheus-generated plan.
argument-hint: "[plan file] [--worktree <path>]"
---

# Plan Execution Mode — start-work

This command runs in the main session at depth 0. The `Agent` tool is available,
so orchestration is real: parallel fan-out to `executor`, independent F1
via `oracle`, specialist escalation via `hephaestus`/`explore`/`librarian` as
needed. No depth-1 degradation.

## Mandatory MUST REFUSE Clause

This command body runs in the main session at depth 0. If this command somehow
executes in a context where the `Agent` tool is unavailable (subagent depth >= 1,
or stripped by platform), REFUSE and exit immediately.

There is no degraded mode. Do not implement tasks directly. Do not self-review.
Do not attempt a partial execution. Emit the refusal message below and return:

```
ERROR: start-work requires full `Agent`-tool access and was invoked in a context
where the tool is stripped (subagent depth >= 1). There is no degraded-mode
fallback — orchestration, delegation, and F1-F4 independent review all require
`Agent`.

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

1. `mode_read(mode="boulder")` — if `active_plan` points to a valid file with
   unchecked boxes → resume that plan directly (skip steps 2-3).

2. No active boulder (or plan fully checked) → search both plan surfaces:
   - `.omca/plans/*.md`
   - `.claude/plans/*.md`

3. Merge results, deduplicate by absolute path, label each as `[active]`,
   `[omca]`, or `[native]`.

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

### 2.2 Background Agent Barrier

When N background agents launched and first completes:

1. COUNT task-notifications received vs agents launched.
2. IF received < launched: acknowledge result briefly, say "Waiting for N more...", END response.
3. IF received == launched: all results in — proceed.

Claude Code delivers one notification per turn. Ending your response immediately
unblocks queued notifications. Never act on partial results from parallel
background agents.

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

## FROZEN Plan Discipline

After flipping the LAST `- [ ]` → `- [x]`, BEFORE running F1-F4:

Write `STATE_DIR/pending-final-verify.json` (UNCONDITIONAL):

```json
{
  "plan_path": "<absolute path to plan file>",
  "plan_sha256": "<hex digest of the now-frozen plan file>",
  "marked_at": <unix timestamp>,
  "session_id": "<value of CLAUDE_SESSION_ID env var, or equivalent>"
}
```

- `plan_sha256` computed from plan AFTER last flip, before further edits.
- `session_id` for cross-session staleness detection.
- `pending-final-verify.json` is cleared automatically by
  `scripts/final-verification-evidence.sh` once all 4 F-type evidence entries for
  this plan's SHA are present (Task 4c), or manually via
  `mode_clear(mode="all"|"final_verify")` (Task 4b).
- PLAN FILE FREEZE RULE: Once the marker is written, execution notes during F1-F4
  go to `.omca/notes/`. Any further edits to the plan file would produce a SHA256
  mismatch error.
- Plans generated by prometheus no longer include a final-checklist section; the `.omca/notes/<plan>-completion.md` sidecar serves that role (see Completion Sidecar section below).

## Final Verification Wave

MANDATORY — runs after ALL plan tasks complete. Spawn 4 review agents. ALL must
APPROVE. Present results, get explicit user "okay" before reporting completion.

**Do NOT auto-proceed after F1-F4. Wait for user approval.**

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each requirement: verify implementation exists
  (read file, run command). For each constraint: search codebase for violations.
  Compare deliverables against plan.
  Output: `Requirements [N/N] | Constraints [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `executor`
  Run build + lint + test commands. Review all changed files for: empty catches,
  console.log in prod, commented-out code, unused imports. Check for AI slop:
  excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Manual QA** — `executor`
  Execute EVERY QA scenario from EVERY task. Test cross-task integration. Test
  edge cases: empty state, invalid input, rapid actions.
  Output: `Scenarios [N/N pass] | Integration [N/N] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `executor`
  For each task: read spec, read actual diff. Verify 1:1 — everything in spec was
  built, nothing beyond spec was built. Detect cross-task file contamination.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | VERDICT`

Delegation routing:

```text
F1 (Architecture Review):
Agent(subagent_type="oh-my-claudeagent:oracle", prompt="[6-section prompt with F1 review scope]")

F2-F4 (Test, QA, Scope):
Agent(subagent_type="oh-my-claudeagent:executor", prompt="[6-section prompt with F2/F3/F4 details]")
```

After ALL 4 APPROVE: present results to user, get explicit "okay", then report completion.
After ANY REJECT: fix issues, re-run that reviewer only, present again.

### Anti-Rationalization Clauses

"Direct file inspection is NOT a substitute for F1-F4. They are independent
verifications by separate agents whose blind spots cannot match yours."

"If you find yourself thinking 'F1-F4 wouldn't change the outcome', that is
exactly when F1-F4 is most needed — the rationalization is itself a confirmation
bias signal."

"F1-F4 must run on EVERY plan, even short ones, even after direct verification.
Each F-step is delegated to its own agent (oracle for F1, executor for
F2-F4); self-review is not permitted. If `Agent` is unavailable, this command
refuses per the Mandatory MUST REFUSE Clause and the plan does not proceed."

Never collapse to 1 pass. Two combined passes minimum.

## Evidence Logging Mandate

Use `evidence_log` after EVERY verification command. The task-completion hook
enforces this — no evidence, no done.

Standard pattern:
```
evidence_log(
  evidence_type="...",
  command="...",
  exit_code=0,
  output_snippet="plan_sha256:<sha256> ...",
  plan_sha256="<sha256>",
  verified_by="executor"
)
```

F1-F4 evidence calls (substitute actual plan SHA256):

```
evidence_log(
  evidence_type="final_verification_f1",
  command="oracle: APPROVE",
  exit_code=0,
  plan_sha256="<hex>",
  output_snippet="plan_sha256:<hex> verdict:APPROVE"
)
evidence_log(
  evidence_type="final_verification_f2",
  command="executor: APPROVE",
  exit_code=0,
  plan_sha256="<hex>",
  output_snippet="plan_sha256:<hex> verdict:APPROVE"
)
evidence_log(
  evidence_type="final_verification_f3",
  command="executor: APPROVE",
  exit_code=0,
  plan_sha256="<hex>",
  output_snippet="plan_sha256:<hex> verdict:APPROVE"
)
evidence_log(
  evidence_type="final_verification_f4",
  command="executor: APPROVE",
  exit_code=0,
  plan_sha256="<hex>",
  output_snippet="plan_sha256:<hex> verdict:APPROVE"
)
```

**Dual-shape convention**: pass `plan_sha256` as an explicit parameter (preferred,
structured access) AND embed `plan_sha256:<sha>` in `output_snippet` for
back-compat during the transition window.

F-step evidence table:

| F-step | `evidence_type`          | `command` example           | `exit_code` | `plan_sha256`       | `output_snippet`                      |
|--------|--------------------------|-----------------------------|-------------|---------------------|---------------------------------------|
| F1     | `final_verification_f1`  | `oracle: APPROVE`           | 0=APPROVE, 1=REJECT | `<hex>` (first-class) | `plan_sha256:<hex> verdict:APPROVE` |
| F2     | `final_verification_f2`  | `executor: APPROVE`  | 0=APPROVE, 1=REJECT | `<hex>` (first-class) | `plan_sha256:<hex> verdict:APPROVE` |
| F3     | `final_verification_f3`  | `executor: APPROVE`  | 0=APPROVE, 1=REJECT | `<hex>` (first-class) | `plan_sha256:<hex> verdict:APPROVE` |
| F4     | `final_verification_f4`  | `executor: APPROVE`  | 0=APPROVE, 1=REJECT | `<hex>` (first-class) | `plan_sha256:<hex> verdict:APPROVE` |

Session termination is blocked until all 4 F-type entries are present.

## Auto-Continue Policy

NEVER ask "should I continue" between plan steps. After verification passes →
immediately delegate next task.

**Pause only when**: plan needs clarification, blocked by external dependency,
critical failure.

**Scope**: Between implementation tasks only. Final Verification Wave (F1-F4) →
MUST wait for explicit user approval.

### Stop Conditions

| Condition    | Signal                                                | Action                                             |
|--------------|-------------------------------------------------------|----------------------------------------------------|
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
- **`boulder_progress`**: Task completion counts
- **`mode_read()`**: Active persistence modes
- **`mode_clear()`**: Deactivate modes. `mode_clear(mode="ralph")` for selective
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
