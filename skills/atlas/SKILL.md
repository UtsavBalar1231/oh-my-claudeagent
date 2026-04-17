---
name: atlas
description: Execute work plans via the Atlas orchestrator. Delegates all tasks, verifies results.
user-invocable: true
argument-hint: "[plan file or task description]"
shell: bash
effort: high
---

Equivalent to `/oh-my-claudeagent:start-work <plan>`. Use either interchangeably.

Execute the following: $ARGUMENTS

**vs `/sisyphus-orchestrate`**: Use atlas with a structured plan (from prometheus) with checkboxed tasks. Use `/sisyphus-orchestrate` for open-ended work where the plan emerges during execution.

This skill runs in the main session at depth 0. The `Agent` tool is available, so orchestration is real: parallel fan-out to `sisyphus-junior`, independent F1 via `oracle`, specialist escalation via `hephaestus`/`explore`/`librarian` as needed. No depth-1 degradation.

## Plan Selection

No task specified → find plans by priority:
1. `mode_read` — active plan exists → resume it
2. Search `.omca/plans/*.md` and `.claude/plans/*.md`
3. Merge candidates, deduplicated by path, labeled `[omca]` or `[native]`

## Execute Plan

This skill runs inline in the main session at depth 0 — the `Agent` tool is always available. No pre-flight probe, no degraded-mode fallback. If you ever see evidence that this is running at subagent depth ≥ 1, stop and report: you are in the wrong context.


### Step 1: Register and Analyze

`boulder_write(active_plan="<path>", plan_name="<name>", session_id="<current>")` — BEFORE delegating.

Read FULL plan file. Parse `- [ ]` checkboxes. Build parallelization map: simultaneous tasks, dependencies, file conflicts.

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
  subagent_type="oh-my-claudeagent:sisyphus-junior",
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

`evidence_log(evidence_type="...", command="...", exit_code=0, output_snippet="...", plan_sha256="<sha256>", verified_by="sisyphus-junior")`

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

- [ ] F2. **Code Quality Review** — `sisyphus-junior`
  `Agent(subagent_type="oh-my-claudeagent:sisyphus-junior", prompt="[6-section prompt with F2 details]")`
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Manual QA** — `sisyphus-junior`
  Output: `Scenarios [N/N pass] | Integration [N/N] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `sisyphus-junior`
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
