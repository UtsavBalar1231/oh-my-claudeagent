---
name: ultrawork
description: Maximum parallel execution mode. Spawns multiple agents simultaneously for fastest completion.
argument-hint: "[task or list of parallel tasks]"
---

# Ultrawork Mode - Maximum Parallelism

Aggressive parallelization. Multiple agents concurrent. No waiting when unnecessary.

## When to Parallelize

**ALWAYS**: different files, different modules, no data dependencies, combined work >30s.

**NEVER**: output dependency, same file, sequential order matters.

## Certainty Protocol

No implementation until 100% certain. Before coding:
- FULLY UNDERSTAND what user wants (not assumes)
- EXPLORE codebase for patterns
- CLEAR WORK PLAN — vague plan = failed work
- RESOLVE ALL AMBIGUITY — unclear → ASK or INVESTIGATE

Not ready if: assumptions about requirements, unsure which files, don't understand existing code, "probably"/"maybe" in plan.

## Parallel Execution Pattern

### Step 1: Analyze Tasks

```
Tasks:
1. Implement user service (touches: src/services/user.ts)
2. Implement auth service (touches: src/services/auth.ts)
3. Add user tests (touches: src/services/user.test.ts)
4. Add auth tests (touches: src/services/auth.test.ts)
5. Update API routes (touches: src/routes/api.ts)

Dependencies:
- Task 3 depends on Task 1
- Task 4 depends on Task 2
- Task 5 depends on Task 1 and Task 2
```

### Step 2: Group into Parallel Batches

```
Batch 1 (parallel):
  - Task 1: user service
  - Task 2: auth service

Batch 2 (parallel, after Batch 1):
  - Task 3: user tests
  - Task 4: auth tests
  - Task 5: API routes
```

### Step 3: Launch Parallel Agents

```
# Batch 1 - Launch simultaneously
Agent(subagent_type="oh-my-claudeagent:executor", prompt="Implement user service...")
Agent(subagent_type="oh-my-claudeagent:executor", prompt="Implement auth service...")

# Wait for Batch 1

# Batch 2 - Launch simultaneously
Agent(subagent_type="oh-my-claudeagent:executor", prompt="Add user tests...")
Agent(subagent_type="oh-my-claudeagent:executor", prompt="Add auth tests...")
Agent(subagent_type="oh-my-claudeagent:executor", prompt="Update API routes...")
```

## Agent Selection for Speed

| Task | Best Agent | Why |
|------|------------|-----|
| Quick lookup | `explore` with `model=haiku` | Fast, cheap |
| Standard implementation | `executor` | Good balance |
| Complex logic | `executor` with `model=opus` | Gets it right first time |
| UI work | `executor` + `/oh-my-claudeagent:frontend-ui-ux` skill | Frontend skill provides specialization |

**Tip**: Use `model=haiku` for simple tasks, `model=opus` for complex ones. Sonnet is the default.

**Default behavior: DELEGATE. Do not work yourself unless the task is trivially simple (1-2 lines, obvious change) and you have all context already loaded.**

## Ultrawork Tracking Format

Track parallel execution with TaskCreate/TaskUpdate:

```
TaskCreate(subject="Batch 1 - User service", description="[Agent 1]")
TaskCreate(subject="Batch 1 - Auth service", description="[Agent 2]")
TaskCreate(subject="Batch 2 - User tests", description="[Agent 3] - blocked by Batch 1")
TaskCreate(subject="Batch 2 - Auth tests", description="[Agent 4] - blocked by Batch 1")
TaskCreate(subject="Batch 2 - API routes", description="[Agent 5] - blocked by Batch 1")
TaskCreate(subject="Verification - Run all tests")
TaskCreate(subject="Verification - Build check")
```

## Handling Failures

1. Don't stop others — let them complete
2. Collect all results
3. Analyze failures
4. Create fix tasks for next batch
5. Continue — one failure doesn't block everything

## Maximum Concurrency

5 agents max. More = coordination overhead > throughput.

## Verification

After all parallel work:
1. Aggregate results, check conflicts
2. Integration tests, verify combined functionality
3. Architect review if complex
4. `evidence_log(type, command, exit_code, output_snippet)` for all
5. `evidence_read` before reporting completion

## Example Ultrawork Session

```
User: "ulw fix all TypeScript errors in src/"

1. Analyze: Find all TS errors
   $ bun run typecheck 2>&1 | grep "error TS"

2. Group by file (each file = independent task)

3. Launch parallel batch:
   - Agent 1: Fix errors in src/auth/
   - Agent 2: Fix errors in src/api/
   - Agent 3: Fix errors in src/utils/
   - Agent 4: Fix errors in src/models/

4. Wait for all agents

5. Re-run typecheck

6. If errors remain, create new batch

7. Verify: Zero errors, tests pass
```

## Anti-Optimism Checkpoint

Before claiming done:

1. Tests run and PASS? (not "should pass")
2. Read actual output of every command? (not skimmed)
3. EVERY requirement implemented? (re-read request NOW)
4. Evidence recorded via `evidence_log`? (not "verified mentally")
5. Key learnings/issues via `notepad_write`?

**Any no → GO BACK. Do not claim completion.**

| If your change... | YOU MUST... |
|---|---|
| Adds/modifies a CLI command | Run the command with Bash. Show the output. |
| Changes build output | Run the build. Verify output files exist and are correct. |
| Modifies API behavior | Call the endpoint. Show the response. |
| Changes UI rendering | Describe what renders. Use a browser tool if available. |
| Adds a new tool/hook/feature | Test it end-to-end in a real scenario. |
| Modifies config handling | Load the config. Verify it parses correctly. |

**Unacceptable QA claims:**
- "This should work" → RUN IT.
- "The types check out" → Types don't catch logic bugs. RUN IT.
- "Tests pass" → Tests cover known cases. Does the ACTUAL FEATURE work? RUN IT.

**You have Bash, you have tools. There is ZERO excuse for not running manual QA.**

## Persistence

State managed by persistence layer. Don't clear manually — use `/oh-my-claudeagent:stop-continuation`. While active, Claude won't stop until all work verified.

## When All Work Delegated

All work in background agents → END RESPONSE, wait for notifications. No log reading, transcript parsing, or state polling.

**Background Agent Barrier**: Notification while others running → acknowledge briefly, END response. No consolidation until ALL reported.

## Anti-Patterns (NEVER)

- Sequential when parallel possible
- Waiting for one before starting independent work
- More than 5 agents at once
- Parallelizing shared-file tasks
- Skipping post-parallel verification
