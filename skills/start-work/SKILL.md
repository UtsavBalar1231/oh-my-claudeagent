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

Start executing a Prometheus-generated plan.

## Plan Mode Handling (Step 0)

Plan mode active → call `ExitPlanMode` first. Plugin agents have `permissionMode` stripped — atlas inherits parent session context.

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

5. **Read plan** and execute via atlas workflow

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

1. Read FULL plan file
2. Identify waves, dependencies, parallelizable groups
3. Delegate via `Agent(subagent_type="oh-my-claudeagent:sisyphus-junior")` — one task per agent
4. Parallel independent tasks (up to 5 concurrent)
5. Verify each output before marking complete
6. `evidence_log(type, command, exit_code, output_snippet)`

Atlas workflow: delegate, verify, mark checkboxes, repeat.

## Critical

- `boulder_write` BEFORE starting — tracks execution metadata
- Read FULL plan before delegating
- Atlas 6-section delegation prompt format
