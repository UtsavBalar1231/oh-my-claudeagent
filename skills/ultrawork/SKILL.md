---
name: ultrawork
description: Maximum parallel execution mode. Spawns multiple agents simultaneously for fastest completion. Use for "ulw", "ultrawork", "fast", "parallel".
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent
user-invocable: true
model: sonnet
argument-hint: "[task or list of parallel tasks]"
---

# Ultrawork Mode - Maximum Parallelism

Speed through parallelism. Launch multiple agents. Work on everything at once.

## Core Philosophy

> "If tasks are independent, they should run simultaneously."

Ultrawork is about **aggressive parallelization**:
- Multiple agents working concurrently
- No waiting when waiting isn't necessary
- Maximum throughput

## When to Parallelize

**ALWAYS parallelize when:**
- Tasks touch different files
- Tasks are in different modules
- Tasks have no data dependencies
- Combined work > 30 seconds

**DO NOT parallelize when:**
- Task B depends on Task A's output
- Tasks modify the same file
- Sequential order matters for correctness

## Certainty Protocol

**YOU MUST NOT START ANY IMPLEMENTATION UNTIL YOU ARE 100% CERTAIN.**

Before writing code, you MUST:
- **FULLY UNDERSTAND** what the user ACTUALLY wants (not what you ASSUME)
- **EXPLORE** the codebase to understand existing patterns and architecture
- **HAVE A CLEAR WORK PLAN** — if your plan is vague, your work will fail
- **RESOLVE ALL AMBIGUITY** — if anything is unclear, ASK or INVESTIGATE

**Signs you are NOT ready to implement:**
- You're making assumptions about requirements
- You're unsure which files to modify
- You don't understand how existing code works
- Your plan has "probably" or "maybe" in it
- You can't explain the exact steps you'll take

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
Agent(subagent_type="oh-my-claudeagent:sisyphus-junior", prompt="Implement user service...")
Agent(subagent_type="oh-my-claudeagent:sisyphus-junior", prompt="Implement auth service...")

# Wait for Batch 1

# Batch 2 - Launch simultaneously
Agent(subagent_type="oh-my-claudeagent:sisyphus-junior", prompt="Add user tests...")
Agent(subagent_type="oh-my-claudeagent:sisyphus-junior", prompt="Add auth tests...")
Agent(subagent_type="oh-my-claudeagent:sisyphus-junior", prompt="Update API routes...")
```

## Agent Selection for Speed

| Task | Best Agent | Why |
|------|------------|-----|
| Quick lookup | `explore` with `model=haiku` | Fast, cheap |
| Standard implementation | `sisyphus-junior` | Good balance |
| Complex logic | `sisyphus-junior` with `model=opus` | Gets it right first time |
| UI work | `sisyphus-junior` + `/oh-my-claudeagent:frontend-ui-ux` skill | Frontend skill provides specialization |

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

## Handling Parallel Failures

When one parallel agent fails:

1. **Don't stop others** - Let them complete
2. **Collect all results** - Success and failures
3. **Analyze failures** - What went wrong?
4. **Create fix tasks** - Add to next batch
5. **Continue** - Don't let one failure block everything

## Maximum Concurrency

Recommended limits:
- **5 agents** maximum simultaneously
- More agents = more coordination overhead
- Quality matters more than quantity

## Verification in Ultrawork

After all parallel work completes:

```
1. Aggregate results
2. Check for conflicts (rare with good batching)
3. Run integration tests
4. Verify combined functionality
5. Architect review if complex
6. Record all results via evidence_log(type, command, exit_code, output_snippet)
7. Review all evidence via `evidence_read` before reporting completion
```

## Phrases That Activate Ultrawork

- "ulw"
- "ultrawork"
- "fast"
- "parallel"
- "as fast as possible"
- "simultaneously"

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

Before claiming done, answer honestly:

1. Did I run the tests and see them PASS? (not "they should pass")
2. Did I read the actual output of every command? (not skim)
3. Is EVERY requirement from the request actually implemented? (re-read the request NOW)
4. Did I record evidence for every verification with `evidence_log`? (not "I verified it mentally")
5. Did I record key learnings or issues via `notepad_write`?

**If ANY answer is no → GO BACK AND DO IT. Do not claim completion.**

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

## State Files

Ultrawork mode state is stored in `.omca/state/ultrawork-state.json`.
This file is created automatically by the keyword detector when "ulw" or "ultrawork" is typed.

**Do NOT delete this file until all work is verified complete.**

To deactivate ultrawork, use `/oh-my-claudeagent:stop-continuation` which clears all persistence state.

The Stop hook checks this file alongside ralph-state.json — while either is active, Claude will
be prevented from stopping prematurely.

## Anti-Patterns (NEVER)

- Running tasks sequentially when they could be parallel
- Waiting for one agent before starting independent work
- Launching more than 5 agents at once
- Parallelizing tasks that share files
- Skipping verification after parallel work
