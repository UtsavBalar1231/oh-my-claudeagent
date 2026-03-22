---
name: start-work
description: Start a work session from a Prometheus-generated plan.
context: fork
agent: oh-my-claudeagent:atlas
user-invocable: true
argument-hint: "[plan file] [--worktree <path>]"
effort: high
---

# Start Work Session

Start a work session from a Prometheus-generated plan.

## Plan Mode Handling (Step 0)

If plan mode is still active when start-work is invoked:
- Atlas has `permissionMode: acceptEdits` which overrides inherited plan mode
- This means execution proceeds normally — no explicit ExitPlanMode call needed
- Log: "Plan mode detected — atlas overriding with acceptEdits for execution"

If you encounter plan mode restrictions despite the above:
- Call `ExitPlanMode` to exit plan mode before proceeding
- Then continue with step 1

## What To Do

1. **Find available plans** (multi-source):
   a. Check `.omca/state/boulder.json` first — if `active_plan` field exists and points to a valid file, use it directly
   b. If no active boulder, search BOTH locations:
      - `.omca/plans/*.md` (plugin-generated plans from prometheus)
      - `~/.claude/plans/*.md` (Claude Code native plan mode plans)
   c. Merge results, deduplicated by filename, with source labels: `[omca]` or `[native]`

2. **Check for active state**: Read `.omca/state/boulder.json` if it exists

3. **Decision logic**:
   - If `.omca/state/boulder.json` exists AND plan is NOT complete (has unchecked boxes):
     - **APPEND** current session to session_ids
     - Continue work on existing plan
   - If no active plan OR plan is complete:
     - List available plan files
     - If ONE plan: auto-select it
     - If MULTIPLE plans: show list with timestamps, ask user to select

4. **Create/Update `.omca/state/boulder.json`**:
   ```json
   {
     "active_plan": "/absolute/path/to/plan.md",
     "started_at": "ISO_TIMESTAMP",
     "session_ids": ["session_id_1", "session_id_2"],
     "plan_name": "plan-name",
     "worktree_path": "/absolute/path/to/worktree"
   }
   ```

   Prefer `boulder_write(active_plan, plan_name, session_id)` to create/update boulder state.
   The MCP tool enforces session deduplication and preserves `started_at` — providing guarantees that manual JSON writes cannot.

5. **Read the plan file** and start executing tasks according to atlas workflow

## Worktree Support

### If `--worktree <path>` is provided:
1. Validate: Run `git rev-parse --show-toplevel` inside the path
2. If valid: Store `worktree_path` in boulder.json and inject worktree active instructions:

   **CRITICAL — DO NOT FORGET**: You are working inside a git worktree. ALL operations MUST target paths under the worktree directory.
   - Every file read, write, edit, and git operation MUST use worktree paths
   - When delegating to subagents, INCLUDE the worktree path in delegation prompts
   - NEVER operate on the main repository directory

3. If invalid: Show setup instructions: `git worktree add <path> <branch>`

### If no `--worktree` flag:
1. Check if boulder.json already has `worktree_path` (resume case) — use it
2. Otherwise, show worktree setup prompt:
   - `git worktree list --porcelain` — list existing worktrees
   - Create if needed: `git worktree add <path> <branch>`
   - Store chosen path in boulder.json

### On resume with existing worktree:
- Show the existing `worktree_path` from boulder.json
- If user provides new `--worktree`, update boulder.json with the new path

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

After completing plan discovery and boulder setup above, execute the plan:

1. Read the FULL plan file
2. Analyze task structure: identify waves, dependencies, parallelizable groups
3. Delegate tasks via `Agent(subagent_type="oh-my-claudeagent:sisyphus-junior")` — one task per agent
4. Run independent tasks in parallel (up to 5 concurrent agents)
5. Verify each task's output before marking complete
6. Record evidence: `evidence_log(type, command, exit_code, output_snippet)`

Follow atlas workflow: delegate, verify, mark checkboxes, repeat until done.

## Critical

- Always update `.omca/state/boulder.json` BEFORE starting work
- Read the FULL plan file before delegating any tasks
- Follow atlas 6-section delegation prompt format
