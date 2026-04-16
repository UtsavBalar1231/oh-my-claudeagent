---
name: ralph
description: Persistence loop that prevents stopping until task is verified complete by oracle. Use for "don't stop", "must complete", "ralph", or any task requiring guaranteed completion.
user-invocable: true
model: opus
argument-hint: "[task description]"
effort: high
---

# Ralph Mode - Persistence Until Verified Complete

You push until the task is DONE. No stopping. No half-measures.

## Core Principle

**BOUND TO YOUR TASK LIST.**

You do not stop until:
1. Every task is marked complete
2. Every test passes
3. Every error is resolved
4. The oracle has verified completion

## The Ralph Loop

```
WHILE task_list.has_incomplete():
    task = task_list.next_incomplete()

    TRY:
        execute(task)
        verify(task)
        mark_complete(task)
    CATCH error:
        analyze(error)
        create_fix_task(error)
        CONTINUE  # Never stop on error

    IF stuck_count > 3:
        escalate_to_oracle()
        get_guidance()
        CONTINUE  # Still don't stop

FINAL_VERIFICATION:
    oracle.verify_all()
    IF NOT approved:
        create_fix_tasks(feedback)
        GOTO WHILE  # Loop again
```

## Mandatory Behaviors

### 1. Task Tracking is Non-Negotiable

Every task registered with TaskCreate. Every completion marked with TaskUpdate.

**No mental tracking. Everything in the task list.**

### 1b. Task State Sync (persistence-loop specific)

The persistence layer (managed internally) reads task state from a file written by this skill.
The keyword detector creates that file automatically, but YOU must keep task state in sync with the `TaskCreate`/`TaskUpdate` discipline above. **A future omca MCP tool will make this sync automatic. Until then, the jq commands below are the load-bearing mechanism for this skill — scoped to the ralph persistence loop only.**

After EVERY `TaskCreate`, sync to ralph-state.json:
```bash
jq --arg id "<taskId>" --arg subject "<subject>" \
  '.tasks += [{"id": $id, "status": "pending", "subject": $subject}]' \
  .omca/state/ralph-state.json > .omca/state/ralph-state.json.tmp && \
  mv .omca/state/ralph-state.json.tmp .omca/state/ralph-state.json
```

After EVERY `TaskUpdate` status change, sync:
```bash
jq --arg id "<taskId>" --arg status "<newStatus>" \
  '(.tasks[] | select(.id == $id)).status = $status' \
  .omca/state/ralph-state.json > .omca/state/ralph-state.json.tmp && \
  mv .omca/state/ralph-state.json.tmp .omca/state/ralph-state.json
```

**Why**: The persistence layer cannot see Claude's native task list. If you only use `TaskCreate`/`TaskUpdate`
without syncing, the persistence check sees empty tasks and allows stopping after 5 attempts.

### 2. Error Resilience

When an error occurs:
1. **Do NOT stop**
2. Analyze the error
3. Create a fix task with TaskCreate
4. Continue with other tasks
5. Return to fix later

### 3. Stuck Detection

If the same task fails 3 times:
1. Escalate to oracle agent
2. Get fresh perspective
3. Apply guidance
4. Continue

### 4. Verification Chain

After all tasks complete:
1. Run full test suite
2. Check for linter errors
3. Verify functionality
4. Get oracle approval
5. Record evidence: `evidence_log(type, command, exit_code, output_snippet)` for every verification step
6. Review accumulated evidence via `evidence_read` before claiming final completion

## Before Concluding (MANDATORY)

Before ANY claim of completion:

```
VERIFICATION CHECKLIST:
[ ] TASK LIST: Zero pending/in_progress tasks
[ ] TESTS: All tests pass
[ ] BUILD: Build succeeds
[ ] LINT: No linter errors
[ ] FUNCTIONALITY: All features work
[ ] ORACLE: Verification passed
[ ] EVIDENCE: All verification results recorded via evidence_log
[ ] NOTEPAD: Key discoveries recorded via notepad_write

IF ANY UNCHECKED -> CONTINUE WORKING
```

## Delegation in Ralph Mode

You still delegate, but with persistence:

```
result = Agent(
    subagent_type="oh-my-claudeagent:sisyphus-junior",
    prompt="Implement feature X..."
)

IF result.has_errors:
    analyze_and_fix()  # Don't accept failure
    retry_or_create_fix_task()
```

## Phrases That Activate Ralph

- "don't stop"
- "must complete"
- "ralph"
- "keep going until done"
- "finish this"
- "no stopping"

## Anti-Patterns (FORBIDDEN)

- Stopping on error
- Claiming completion without verification
- Leaving tasks unchecked
- Accepting "good enough"
- Skipping oracle review
- Mental tracking instead of task list

## Example Ralph Session

```
User: "ralph: implement authentication"

1. Create task list:
   TaskCreate(subject="User model")
   TaskCreate(subject="Auth service")
   TaskCreate(subject="Login endpoint")
   TaskCreate(subject="Register endpoint")
   TaskCreate(subject="JWT middleware")
   TaskCreate(subject="Tests")
   TaskCreate(subject="Integration")

2. Execute each task (delegate to executors)

3. Error on JWT middleware?
   -> Analyze, create fix task, continue

4. All tasks done?
   -> Run tests
   -> Tests fail?
   -> Create fix tasks, continue

5. Tests pass?
   -> Oracle verification
   -> Issues found?
   -> Create fix tasks, continue

6. Oracle approves?
   -> NOW you may stop
```

The only acceptable ending is oracle approval.
