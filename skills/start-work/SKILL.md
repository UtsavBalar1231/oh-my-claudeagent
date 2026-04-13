---
name: start-work
description: Start a work session from a Prometheus-generated plan.
context: fork
agent: oh-my-claudeagent:atlas
user-invocable: true
argument-hint: "[plan file] [--worktree <path>]"
shell: bash
effort: high
---

# Start Work Session

Start a work session from a Prometheus-generated plan.

## Plan Mode Handling (Step 0)

If plan mode is still active when start-work is invoked:
- Plugin agents have `permissionMode` stripped by Claude Code for security — atlas does NOT override plan mode
- Atlas inherits the parent session's permission context
- Call `ExitPlanMode` to exit plan mode before proceeding with execution
- Then continue with step 1

## What To Do

1. **Find available plans** (both surfaces are valid):
   a. Check boulder state first via `mode_read(mode="boulder")` — if the returned state contains `active_plan` pointing to a valid file, use it directly. Treat boulder as execution metadata only; it stores a pointer to the authoritative plan file.
   b. If no active boulder, search both plan locations:
      - `.omca/plans/*.md` — prometheus-generated plans (primary output location)
      - `.claude/plans/*.md` — Claude-native plan files (if the current session already surfaced a native plan-mode file path, prefer that exact path)
   c. Merge results, deduplicated by absolute path, with clear source labels such as `[active]`, `[omca]`, or `[native]`

2. **Check for active execution metadata**: Call `mode_read(mode="boulder")` to fetch active execution metadata

3. **Decision logic**:
   - If `mode_read` returns active boulder state AND plan is NOT complete (has unchecked boxes):
     - **APPEND** current session to session_ids
     - Continue work on existing plan
   - If no active plan OR plan is complete:
     - List available plan files
     - If ONE plan: auto-select it
     - If MULTIPLE plans: show list with timestamps, ask user to select

4. **Create/Update boulder execution metadata**:
   The boulder state shape (for reference only — use `boulder_write` MCP tool to create/update, do NOT hand-edit):
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
   The plan body stays at its authoritative location (`.omca/plans/` or `.claude/plans/`) — boulder only stores a pointer.

5. **Read the plan file** and start executing tasks according to atlas workflow

## Worktree Support

### If `--worktree <path>` is provided:
1. Validate: Run `git rev-parse --show-toplevel` inside the path
2. If valid: Store `worktree_path` in the boulder state (via `boulder_write`) and inject worktree active instructions:

   **CRITICAL — DO NOT FORGET**: You are working inside a git worktree. ALL operations MUST target paths under the worktree directory.
   - Every file read, write, edit, and git operation MUST use worktree paths
   - When delegating to subagents, INCLUDE the worktree path in delegation prompts
   - NEVER operate on the main repository directory

3. If invalid: Show setup instructions: `git worktree add <path> <branch>`

### If no `--worktree` flag:
1. Check if the boulder state already has `worktree_path` (resume case) — use it
2. Otherwise, show worktree setup prompt:
   - `git worktree list --porcelain` — list existing worktrees
   - Create if needed: `git worktree add <path> <branch>`
   - Store chosen path in the boulder state via `boulder_write`

### On resume with existing worktree:
- Show the existing `worktree_path` from the boulder state
- If user provides new `--worktree`, update the execution metadata via `boulder_write` with the new path

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

- Always update the boulder state via `boulder_write` BEFORE starting work — it tracks execution metadata, not plan ownership
- Read the FULL plan file before delegating any tasks
- Follow atlas 6-section delegation prompt format
