---
name: start-work
description: Start a work session from a planner-generated plan.
user-invocable: true
disable-model-invocation: true
argument-hint: "[run name] [--worktree <path>]"
---

Call `health_check` first, loading it if needed: `ToolSearch({query: "select:mcp__plugin_oh-my-claudeagent_omca__health_check", max_results: 1})`. Proceed only when `runtime` is `ok`; otherwise repeat `runtime_reason` to the user, tell them to run `/oh-my-claudeagent:omca-setup`, and stop. If the tool is still missing, say OMCA's server is not connected and stop.

# Run execution: start-work

Load the task tools, which are deferred here: `ToolSearch({query: "select:TaskCreate,TaskUpdate,TaskList,TaskGet", max_results: 4})`.

This command runs in the main session at depth 0, so orchestration is real: parallel fan-out to `executor`, escalation to `build-fixer`, `explorer` or `researcher` as needed. A run lives on Claude Code's task list, which outlives compaction, `/clear` and a new session.

The platform's Workflow tool is not a substitute. Its agents never call `evidence_log` and never reach the task list.

## Refusal clause

If the `Agent` tool is not in your tool list (a `--tools`, `--disallowedTools`, or deny-rule restriction removed it), refuse and return. There is no degraded mode. Do not implement tasks directly or attempt a partial execution. Emit this message and return:

```
ERROR: start-work needs the `Agent` tool to delegate a run's tasks, and this session
does not have it. There is no degraded-mode fallback.

Run it from a session where the Agent tool is available:
  /oh-my-claudeagent:start-work
```

## Find the run

When plan mode is active, call `ExitPlanMode` first. Plugin agents cannot set their own `permissionMode`, so delegated agents inherit plan mode and could not edit.

The task tools do not return metadata. `TaskList` prints `#id [status] subject (owner) [blocked by #a, #b]`, and `TaskGet` adds the description and the full `Blocked by:` list. Read a run through its final task:

1. Call `TaskList`. Each open task with the subject `Final verification` is one open run.
2. Call `TaskGet` on it. Its description gives the run's name and the path of its plan document. Its `Blocked by:` line lists the run's other tasks.
3. Leave alone any task no final task lists. It belongs to no run.

Then choose:

- **One open run**: take it.
- **Several open runs**: take the one the argument names, either the run's name or the path of its plan document, whose basename is the run's name. With no such argument, ask with `AskUserQuestion`, giving each run's name and its completed and total task counts.
- **None**: say there is no open run, tell the user to run `/oh-my-claudeagent:plan`, and stop. An argument that names no open run gets the same answer, with the open runs listed.

Before the first delegation:

- Read the plan document. It holds the why, the constraints and the tradeoffs. The tasks hold the work.
- Read the run's notepad with `notepad_read(plan_name="<run>")`, loading it if needed: `ToolSearch({query: "select:mcp__plugin_oh-my-claudeagent_omca__notepad_read", max_results: 1})`. `plan_name` always holds the run's name. The `issues` section names the tasks closed as blocked, which `TaskList` prints with their last status.
- Treat an `[in_progress]` task the notepad does not close as interrupted. Check what the working tree already holds for it, then delegate it again with that state in the prompt.

If `--worktree <path>` is given, validate it with `git rev-parse --show-toplevel` inside the path. When valid, record it with `notepad_write(plan_name="<run>", section="decisions", ...)` and make every delegation prompt target that worktree's paths. When invalid, show the setup command `git worktree add <path> <branch>` and stop. A resumed session reads the path back from `decisions`.

Tell the user which run this is and how many of its tasks are complete.

## The loop

1. A task closed as blocked keeps its last status (`pending` or `in_progress`) in `TaskList`, so read the run with OMCA's `task_list`, loading it if needed: `ToolSearch({query: "select:mcp__plugin_oh-my-claudeagent_omca__task_list", max_results: 1})`. It prints `[closed as blocked: <why>]` and `[waiting on #N]`. Take the run's lowest-id tasks that show `[pending]` with no `[closed as blocked]` and no `[waiting on]`. The final task comes last: a task closed as blocked does not hold it back. When `task_list` is missing, take the `issues` section of the notepad as the record of the blocked tasks and skip them.
2. Run tasks together when they do not depend on each other and their files do not overlap. Otherwise run them one at a time.
3. Mark each task `in_progress` with `TaskUpdate`, then delegate it to `executor` with the prompt below, one task per delegation. Executors never touch the list: a subagent running in the background has no task tools, and subagents run in the background here.
4. Review each result and rerun its checks (see Verify after every delegation), and log evidence.
5. Complete the task with `TaskUpdate` only after that review passes. Never complete a task whose work was not done. Close it as blocked instead.
6. Repeat until only the final task is open, then run the completeness review.

## Delegation prompt

Every delegation prompt carries these five sections. Call `TaskGet` first: `TaskList` shows only the title.

```markdown
## 1. TASK
[The task's full subject and full description, quoted verbatim.]

## 2. DONE WHEN
- Paths touched: [the files the description names]
- Behavior: [what the code does afterwards]
- Proof: `[command]` passes, taken from the description's acceptance check

## 3. TOOLS
- [tool]: [what it is for here]

## 4. SCOPE
- [Every requirement the task states: the pattern to follow at reference file:lines, the cases to test]
- [Every exclusion the description states, restated verbatim, and each constraint from the plan document that bears on this task]
- Write the smallest diff that satisfies the task. Validation at trust boundaries, error and data-loss handling, security, and anything the task asks for are never what gets cut.

## 5. CONTEXT
### Run
[The run's name, which is the `plan_name` for `notepad_write`.]
### Dependencies
[What the tasks in its `Blocked by:` line built]
### Files in play
[The description's paths, plus what already exists at each]
```

Quoting the title alone yields no paths, no acceptance check and no exclusions. Section 1 carries the task as written, and the other sections carry it as instructions, so copying a line into its target section does not replace quoting it. If a description is thin, say so in section 1, so the executor knows the thinness belongs to the task and not to a truncation.

```text
Agent(
  subagent_type="oh-my-claudeagent:executor",
  prompt=`[FULL 5-SECTION PROMPT]`
)
```

Executor runs on `sonnet` at effort `high`. The `Agent` call's `effort` input is the per-task lever, and it overrides the agent's declared effort for that run. A description with an `Effort:` line goes out with `effort` set to that level. Without one, set `effort` only for a clear mismatch: `low` for a mechanical edit or a lookup, `medium` for a scoped change that follows a named pattern, `xhigh` or `max` only for hard reasoning.

A task whose description leaves a design choice open goes out with `model="opus"` on that one call.

## Results

A subagent's deliverable arrives in the `<result>` block of its `<task-notification>`, or as the Agent tool's return value where the platform ran it in the foreground; those are the only two places a result exists, so never claim a result you have not received in one of them. While an agent is outstanding, carry on with work that does not overlap what it was asked to do.
Do not read or tail the agent's output file: for a subagent it is the full JSONL transcript rather than a plain result, and reading it will overflow your context. The OMCA Default output style carries the full statement of this, under "Claude Code".

Send a parallel group as several `Agent` calls in one message. The platform refuses a spawn once 20 subagents are running (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, not enforced in ultracode sessions), failing with `Concurrent subagent limit reached`, so split a wider group into back-to-back batches and count the agents still running. Tool calls in one message run at most 10 at a time by default (`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`). Each spawn re-establishes context and each report costs a read, so reach for `explorer` or `researcher` only when a delegation needs a fact a few reads of your own cannot supply.

When a deliverable comes back partial or as a bare stub, continue that agent once with `SendMessage` and ask for what is missing. A notice that the agent is waiting on its own background work carries no deliverable yet, so wait for its next notification. One that says a usage limit stopped it means relaunch the task after the limit resets, or report it. One that says a message reached it too late for its result means the result stands; resend the message with `SendMessage` only if it still matters.

Review each deliverable as it lands: reading one executor's diff does not overlap the tasks still running. Hold group-wide steps (the project-level build and test run, the next dependent wave) until every result in the group is in. When waiting is all that is left, say how many results remain and end the response.

## Verify after every delegation

Rerun the description's acceptance check yourself and confirm it passes. Run the project-level build and test suite once the whole parallel group has landed, not after each task: sibling executors edit the same working tree, so a mid-group run reports their unfinished edits as this task's failure. If the group suite fails, set every completed task in the group whose diff the failure touches back to `in_progress` before you delegate anything else, so the list never records as done a task the suite rejects.

Mechanical checks are not review. Subagents self-report, and self-reports are not evidence. After the mechanical check passes, read every file the agent created or modified and check what it claimed against what the code does:

- Does it work as expected, not just "should work"?
- Does it match how this codebase already works (naming, error handling, layer boundaries)?
- Did the expected result actually come out, not a plausible-sounding substitute?
- Were the SCOPE requirements and exclusions honored?
- Did the `SLOP PASS:` cut list leave everything load-bearing in place?
- Is this the smallest diff that satisfies the task? If not, send it back with what to drop.

The executor's report ends with a `SLOP PASS:` line: a per-file cut list with the category of each cut, or `no cuts`, or `docs-only, prose pass applied`. Open each file it names and look at what left. The dangerous cuts are the ones the build and the test suite cannot catch, because nothing exercises them:

- a validation removed from a path no test covers, including anything at a trust boundary
- a `// SAFETY:` or invariant justification removed as "obvious"
- an error branch, a cleanup path, or a data-loss guard removed as "defensive"
- a magic-number derivation comment removed as "restates the code"

If the cut list names one and you cannot point at the test that would fail without it, treat the cut as a regression and require it back before completing the task. `no cuts` still gets a diff read.

A review means you can say what each changed line does; until then, keep reading.

If a QA scenario spawned a resource (process, port, container, temp dir, browser session), confirm its teardown before treating the task as verified.

## Evidence

Use `evidence_log` after every verification command. Without evidence, nothing is done.

```
evidence_log(
  evidence_type="test",
  command="...",
  exit_code=0,
  output_snippet="...",
  verified_by="executor"
)
```

| Type                 | When                                       |
|----------------------|--------------------------------------------|
| `build`              | Build or compile command                   |
| `test`               | Test suite run                             |
| `lint`               | Linter or static analysis                  |
| `manual`             | Manual QA scenario                         |
| `final_verification` | The verdict on the run's final task        |

Call `evidence_read` before the final report to summarize the results, loading it if needed: `ToolSearch({query: "select:mcp__plugin_oh-my-claudeagent_omca__evidence_read", max_results: 1})`.

## Final task

Once every other task of the run is completed or closed as blocked:

1. Mark the final task `in_progress`.
2. Run the verification the plan document names and the project's own full check, and log each result with `evidence_log`. When the document names none, run the project's build, lint and test commands.
3. Review completeness yourself: read the plan document end to end, call `TaskGet` on the run's tasks, read the run's full diff, and check that each requirement was implemented and each exclusion was honored. You reviewed every task's diff already, so a fresh reviewer mostly re-derives your findings. Hand the review to the read-only `architect` only when the full diff no longer fits in your remaining context:

   ```text
   Agent(
     subagent_type="oh-my-claudeagent:architect",
     effort="high",
     prompt="[five-section completeness review prompt: the plan document's path, the run's name, whose tasks it reads with `task_list` and `task_get`, and the diff to read. Output: COMPLETE or INCOMPLETE, each blocker citing the requirement it fails.]"
   )
   ```

4. When you have the `advisor` tool, call it once your own verdict is COMPLETE and before you log it. A gap it names that the diff confirms makes the verdict INCOMPLETE.
5. Log the verdict, with the final task's id:

   ```
   evidence_log(
     evidence_type="final_verification",
     command="completeness review of run <name>: plan document, tasks, full diff",
     exit_code=0,
     output_snippet="COMPLETE, all requirements met",
     task_id="<final task id>"
   )
   ```

6. Complete the final task with `TaskUpdate`. Completing it is refused until its verdict is logged. Claude Code empties the list seconds after its last task completes, so collect the task subjects your report needs first.

A blocker cites a requirement or exclusion that the evidence fails. A concern that cites neither is a note: it goes in the final report and leaves the verdict COMPLETE.

On INCOMPLETE, log the verdict with `exit_code=1`, then fix the cited gap: set the task it belongs to back to `in_progress`, or, for a gap no task covers, add one with `TaskCreate` and `metadata: {"run": "<name>"}` and make the final task blocked by it. Review what the fix changed and log a fresh verdict. Re-review at most twice. When the same requirement fails again after that, stop fixing and close its task as blocked.

When the run has tasks closed as blocked, the review still runs over everything that was done, and it cannot call the run COMPLETE. Log `command="completeness review of run <name>: closed with blocked tasks"`, `exit_code=0`, the final task's `task_id`, and an `output_snippet` that names every blocked task and its gap.

A code edit after the verdict puts the verdict out of date. Review and log again after any such edit. Do not report the run finished until the final task is completed.

## Between tasks

Once a task verifies, delegate the next one in the same breath, without checking in.

After completing each task, write the user a short note: which task finished, what verified it, and what runs next. Claude Code collapses thinking by default, so this note is the only progress a user sees during a long run.

While a run this session has touched still has open tasks, stopping continues the session with the next task. A turn that asks the user, or a pause the user asked for, does not count as stalled. These endings stop work you still owe, so do not end a turn on one: a summary that announces the next step, an offer to continue, a list of decisions that block nothing, or a report because a milestone landed. Make the reversible call, note it, and keep going.

Pause only when the run needs clarification that blocks every remaining task, or every remaining task needs something deliberately protected from you (a permission denial, a user's refusal). Say what is protected and what would unblock it; do not route around it.

Every few completed tasks, read the notepad's `issues` section with `notepad_read` and disposition every open entry: add it as a task of the run, defer it with a stated reason, or reject it with a stated reason. The completeness review covers the plan document and the tasks, not the notepad, so an entry left silently unaddressed becomes a gap it will not catch.

| Condition    | Signal                                                  | Action                                               |
|--------------|---------------------------------------------------------|------------------------------------------------------|
| **CONTINUE** | Task passes verification and later tasks are unblocked  | Proceed immediately                                  |
| **BLOCK**    | A task meets a condition under Blocked tasks            | Close it as blocked, carry on with independent tasks |
| **ESCALATE** | Several tasks blocked for one root cause                | The run is aimed wrong: stop, report that cause, and ask the user with `AskUserQuestion` how to proceed |
| **ABORT**    | 3+ consecutive waves with zero net progress             | Stop all work, document state, present to the user, and ask with `AskUserQuestion` how to proceed |

## Failure handling

Before each retry, classify the failure and reduce it to a signature.

- **Class.** A product failure means the code under change is wrong. A harness failure means the environment is: a tool, a network call, a missing credential, a full disk, a test runner that crashed before it ran anything. A harness failure says nothing about the task's code, so do not rewrite working code to answer it.
- **Signature.** The check that failed and its error text, minus whatever differs from run to run: line numbers, timestamps, ports, temp paths, ids. Two attempts with one signature mean the approach is not moving.

A fresh delegation after a failed attempt carries what was tried and why it failed: the exact commands or edits and the observed error. When a relaunched task fails again with the same error, call the `advisor` tool before the next relaunch, when you have it.

A verification failure is never dismissed as a false positive without evidence that the failure itself was spurious, such as a logged flaky-test rerun that then passes.

### Blocked tasks

Close a task as blocked when any of these holds:

- Its failure signature repeats on the next attempt, and a different approach is not apparent.
- A third attempt fails, whatever the signatures.
- It needs something this run cannot get: a credential, an external system, a choice that belongs to the user.
- A permission check denied what it needs, or the user declined it. Do this at once, with no retry.

To close it, do both:

```
TaskUpdate({taskId: "7", metadata: {"blocked": "`bun test src/orders` fails with the same parse error after two approaches (product)"}})
notepad_write(plan_name="<run>", section="issues", content="#7 closed as blocked: <the gap>. Tried: <what was tried>.")
```

`TaskList` keeps printing that task with its last status, and its id stays in its dependents' `[blocked by]`. `task_list` marks it `[closed as blocked: <why>]`, and the notepad entry is the record when that tool is missing. A task closed as blocked is never done, and work that needs it cannot go ahead. Close each task that depends on it the same way, with `needs task #7`, then continue with the independent tasks. An unattended run therefore reaches the final task and reports what it could not do, rather than stalling on the first gap. The final report names every blocked task, its gap and what would unblock it.

`TaskUpdate` with `metadata: {"blocked": null}` reopens a task.

## Critical rules

- Every delegation prompt carries all five sections, and one task per delegation.
- `evidence_log` after every verification command.
- Complete each task immediately after verifying it; do not batch.
- Never trust subagent claims without independent verification.
- Never use `Bash(claude ...)`: use native `Agent(subagent_type=...)`.
