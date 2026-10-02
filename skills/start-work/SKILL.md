---
name: start-work
description: Start a work session from a Prometheus-generated plan.
user-invocable: true
disable-model-invocation: true
argument-hint: "[plan file] [--worktree <path>]"
---

Call `health_check` first. Proceed only when `runtime` is `ok`; otherwise repeat `runtime_reason` to the user, tell them to run `/oh-my-claudeagent:omca-setup`, and stop. If the tool is missing, say OMCA's server is not connected and stop.

# Plan Execution Mode: start-work

This command runs in the main session at depth 0. The `Agent` tool is available,
so orchestration is real: parallel fan-out to `executor`, specialist escalation
via `hephaestus`/`explore`/`librarian` as needed. No depth-1 degradation.

The platform's native Workflow tool is not a substitute for this command. A workflow run
is driven by the platform's own runtime, so its agents never call `evidence_log`, never
bind a plan through boulder, and are never seen by the TaskCompleted gate or the Stop
gates. That makes it a separate lane, not a replacement for plan execution here.

## Refusal Clause

This command body runs in the main session at depth 0. If the `Agent` tool is not in
your tool list (a `--tools`, `--disallowedTools`, or deny-rule restriction removed it),
refuse and return.

There is no degraded mode. Do not implement tasks directly.
Do not attempt a partial execution. Emit the refusal message below and return:

```
ERROR: start-work needs the `Agent` tool to delegate plan tasks, and this session
does not have it. There is no degraded-mode fallback.

Run plan execution from a session where the Agent tool is available:
  /oh-my-claudeagent:start-work <plan>
```

## Plan Discovery Logic (Step 0)

### Plan Mode Handling

Plan mode active → call `ExitPlanMode` first. Plugin agents have `permissionMode`
stripped, delegated agents inherit parent session context.

### Finding the Active Plan

`boulder.json` is a registry: several plans can be tracked concurrently
(`plans[plan_name]`), and each session is bound to at most one of them
(`bindings[session_id]`). Plan selection in this step is what creates or updates that
binding.

1. Check `boulder_progress()`, it resolves this session's bound plan from the
   registry (explicit binding → sole registered plan → most-recently-started plan).
   If it resolves to a valid file with unchecked boxes, resume that work directly
   (skip steps 2-3).

2. No bound plan resolves (or the bound plan is fully checked) → build the selection
   list from two sources:
   - The registry's OTHER concurrently-active plans (`plans[plan_name]` entries not
     bound to this session), each labeled `[active]`, these are plans other sessions
     are mid-execution on. **Exclude any plan whose checkboxes are all checked**,
     completion is derived from the plan file's `- [x]` boxes, not a stored flag, so
     a fully-checked plan never appears in the selection list even if its registry
     entry hasn't been garbage-collected yet.
   - Plan files not yet in the registry, found by searching:
     - `<plans-dir>/*.md` (canonical native plans)
     - `.omca/plans/*.md` (compatibility surface)
     labeled `[available]`.

   `<plans-dir>` is the platform's plans directory: the `plansDirectory` setting when
   it is set (a path relative to the project root), otherwise `~/.claude/plans`. Read
   it from settings before globbing; with `plansDirectory` configured, the default
   path holds nothing and a `~/.claude/plans` glob finds no platform-created plan.

3. Merge results, deduplicate by absolute path.

### Decision Logic

#### Draft gate (checked before anything is executed)

A plan may carry a `**Status**:` field on its metadata line. Read it before executing,
resuming, or auto-selecting a plan:

- `Status` says `FINAL` → executable.
- No `Status` field anywhere in the plan → executable. Plans written before this field
  existed carry no status line, and a missing field must never block execution.
- `Status` is present but says anything other than `FINAL` (`DRAFT` being the common
  case) → REFUSE to execute it. A draft is a plan the user is still being interviewed
  about, and executing one runs work nobody agreed to.

On a refusal, emit this and return without delegating anything:

```
This plan is still a draft (Status: {value}), so start-work will not execute it.

Finish the plan first:
  /oh-my-claudeagent:plan

Once the plan's Status line reads FINAL, re-run:
  /oh-my-claudeagent:start-work {plan path}
```

A refused plan is also excluded from the selection list, so a single draft never
auto-selects. If every candidate is a draft, say so rather than picking one.

- **This session already resolves to a bound plan with unchecked boxes** → append
  session (re-run `boulder_write`, which is idempotent), continue work.
- **No bound plan, or the bound plan is complete** → list available plans (per above,
  completed plans excluded).
  - Single plan found → auto-select.
  - Multiple plans → present list, ask user to choose. Selecting a plan calls
    `boulder_write`, which both upserts `plans[plan_name]` and sets
    `bindings[session_id]` to that plan, this is what "binds" the session.

### Argument Handling

If `[plan file]` argument is provided, use that path directly, skip search.

If `--worktree <path>` is provided:
1. Validate: `git rev-parse --show-toplevel` inside path.
2. Valid → store in boulder via `boulder_write`, inject worktree instructions
   into ALL delegation prompts (all ops target worktree paths).
3. Invalid → show setup: `git worktree add <path> <branch>`.

Without `--worktree`:
1. The resolved plan's registry entry (`plans[plan_name].worktree_path`) is set
   (resume case) → use it. `worktree_path` is per-plan, not global, a session
   resuming a different plan than its own last one gets that plan's worktree, not
   whatever it used previously.
2. Otherwise → show setup prompt, store via `boulder_write`.

### Boulder Write (BEFORE Delegating)

After plan is selected, before any delegation. `boulder_write` is a deferred tool, so
hydrate it with `ToolSearch({query: "select:boulder_write", max_results: 1})` first:

```
boulder_write(
  active_plan="<absolute path to plan file>",
  plan_name="<plan name>",
  session_id="<current session id>",
  agent="sisyphus"
)
```

`<current session id>` is the platform session UUID (the `Session <id>` line OMCA adds
to the session's first prompt, same as the transcript filename), not a
locally-generated banner id. Passing the wrong id here is what desyncs the
statusline TODO counter and every other session-id-keyed lookup against it.

`boulder_write` enforces deduplication and preserves `started_at`. Plan body
stays at its authoritative location, boulder stores a pointer only.

### Output Formats

When listing plans for selection:
```
Available Work Plans

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

Reading plan and continuing from last incomplete task...
```

When auto-selecting single plan:
```
Starting Work Session

Plan: {plan-name}

Reading plan and beginning execution...
```

## Step 1: Register and Analyze

1. `boulder_write(active_plan="<path>", plan_name="<name>", session_id="<current>")`, before delegating.
2. Read the full plan file.
3. Parse `- [ ]` checkboxes.
4. Take the parallel groups from the plan: its `**Parallel Execution**` metadata and the
   `[P]` marker on parallel-safe tasks. Run two tasks together only when their `File:`
   paths do not overlap and every task in their `Depends:` is checked; in a plan without
   `[P]` markers, apply the same two tests to decide.

## 5-Section Prompt Structure

Every delegation prompt includes all five sections.

```markdown
## 1. TASK
[Quote the task's checkbox line AND every sub-bullet beneath it, VERBATIM.
The checkbox line alone is a title, not a task.]

## 2. EXPECTED OUTCOME
- [ ] Files created/modified: [exact paths, from the task's `File:` sub-bullet]
- [ ] Functionality: [exact behavior]
- [ ] Verification: `[command]` passes, taken from the task's `Done when:` sub-bullet

## 3. REQUIRED TOOLS
- [tool]: [what to search/check]

## 4. SCOPE
- [Every requirement the task states: the pattern to follow at reference file:lines,
  the cases to test]
- [Every `Must NOT:` sub-bullet on the task, restated verbatim]
- Write the smallest diff that satisfies the task. Validation at trust boundaries, error
  and data-loss handling, security, and anything the task asks for are never what gets cut.

## 5. CONTEXT
### Dependencies
[What previous tasks built, resolved from the task's `Depends:` sub-bullet]
### Files in play
[The task's `File:` paths, plus what already exists at each]
```

### §1: quote the whole task block, not just the checkbox line

Plan task labels are capped at roughly 80 characters because the statusline truncates
there. All the substance lives in the sub-bullets directly beneath the checkbox line,
contiguous with it and with no blank line between them:

```
- [ ] 7. Imperative task title
  - File: `exact/path.ts`
  - Done when: runnable command or observable state
  - Depends: 2, 3
  - Must NOT: exclusion
  - Effort: low
```

Quoting the checkbox line alone yields a bare title with no paths, no acceptance
criterion and no exclusions, which is strictly less than the executor needs. Quote the
checkbox line plus every sub-bullet under it, verbatim, and stop at the first line that
is not part of that block (a blank line, or the next `- [ ]` line).

Each sub-bullet then feeds a specific section, and the mapping is not a judgment call:

| Sub-bullet    | Feeds                                                            |
|---------------|------------------------------------------------------------------|
| `Done when:`  | §2 EXPECTED OUTCOME, as the verification line                     |
| `Must NOT:`   | §4 SCOPE, restated verbatim                                       |
| `File:`       | §2's "Files created/modified" and §5 CONTEXT                      |
| `Depends:`    | §5 CONTEXT, under Dependencies                                    |
| `Effort:`     | The routing hint `[omca-route effort=<level>]`, the prompt's first line |

A sub-bullet the plan omits is simply absent; do not invent one. Copying it into its
target section does not replace quoting it in §1: §1 carries the task as written, the
other sections carry it as instructions.

**Older plans use a different shape.** Plans written before the sub-bullet template
carry bolded fields instead: `**What to do**`, `**Acceptance Criteria**`,
`**Must NOT do**`. Quote whichever shape the task actually uses rather than assuming
the sub-bullet form, and map the bolded fields the same way: `**Acceptance Criteria**`
to §2, `**Must NOT do**` to §4. A plan is one shape or the other, never both. If a task
has neither shape, the checkbox line is all there is, and §1 says so explicitly so the
executor knows the thinness is the plan's, not a truncation.

Example delegation:

```text
Agent(
  subagent_type="oh-my-claudeagent:executor",
  prompt=`[FULL 5-SECTION PROMPT]`
)
```

Executor runs on `sonnet` at effort `high`. Beside the choice of agent, the routing hint
is the per-task lever for effort. A task with an `Effort:` sub-bullet goes out with
`[omca-route effort=<level>]` as the prompt's first line, above `## 1. TASK`. OMCA's mod
strips that line and runs the subagent at that level; a line that does not parse stays in
the prompt and changes nothing. Without the sub-bullet, add a hint only for a clear
mismatch: `low` for a mechanical edit or a lookup, `medium` for a scoped change that
follows a named pattern, `xhigh` or `max` only for hard reasoning. `high` is the worker
default and needs no hint.

A task whose plan text leaves a design choice open goes out with `model="opus"` on that
one call; a task the plan fully specifies needs no override.

## Parallel Execution Semantics

### 2.1 Parallelization

Parallel tasks: prepare all prompts, invoke in one message, verify all once their results land.
Sequential tasks: one at a time, when the dependency is real rather than for comfort.

A subagent's deliverable arrives in the `<result>` block of its `<task-notification>`, or as the Agent tool's return value where the platform ran it in the foreground; those are the only two places a result exists, so never claim a result you have not received in one of them. While an agent is outstanding, carry on with work that does not overlap what it was asked to do.
Do not read or tail the agent's output file: for a subagent it is the full JSONL transcript rather than a plain result, and reading it will overflow your context. The OMCA Default output style carries the full statement of this, under "Fan-out".

For exploration and research (result needed to plan the next step):
```text
Agent(subagent_type="oh-my-claudeagent:explore", ...)
Agent(subagent_type="oh-my-claudeagent:librarian", ...)
```

For task execution (result needed before the task can be marked complete):
```text
Agent(subagent_type="oh-my-claudeagent:executor", prompt="...", ...)
```

Parallel task group (invoke in one message):
```text
// Tasks 2, 3, 4 are independent, invoke together
Agent(subagent_type="oh-my-claudeagent:executor", prompt="Task 2...")
Agent(subagent_type="oh-my-claudeagent:executor", prompt="Task 3...")
Agent(subagent_type="oh-my-claudeagent:executor", prompt="Task 4...")
```

#### Parallel group width

The platform refuses a spawn once 20 subagents are running concurrently
(`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), failing with `Concurrent subagent limit
reached` and telling you not to retry. A plan's declared parallel group must stay
under that ceiling: if a group lists more tasks than the ceiling allows, split it
into sub-batches and run them back to back. Count agents already running from an
earlier batch, since they still hold their slots. That ceiling is not enforced in
ultracode sessions.

There is no per-session total limit on how many subagents a session may spawn, so
concurrency is the only platform ceiling. It is not the cost ceiling: each spawn
re-establishes context and each report costs a read. Spawn executors for plan tasks, and
reach for `explore` or `librarian` only when a delegation needs a fact that a few reads
of your own cannot supply.

### 2.2 Result Collection

A parallel group is several Agent calls in one message. Each returns a launch
acknowledgement immediately, and each deliverable arrives later in the `<result>` block
of its own `<task-notification>`. Read the deliverable from there. Never Read a
subagent's `.output`/JSONL transcript (overflows context). When a deliverable comes back
partial or as a bare stub, continue that agent once with `SendMessage` and ask for what
is missing; it resumes with its own context instead of re-exploring.

Review each deliverable as it lands: reading one executor's diff does not overlap the
tasks still running. Hold group-wide steps (the project-level build and test run, the
next dependent wave) until every result in the group is in. When waiting is all that is
left, say how many results remain and end the response.

### 2.3 Verify After Every Delegation

Re-run the task's `Done when:` command (its `**Acceptance Criteria**` check in an older
plan) yourself and confirm it passes; that is the per-task mechanical check. Run the
project-level build and test suite once the whole parallel group has landed, not after
each task: sibling executors edit the same working tree, so a mid-group run reports
their unfinished edits as this task's failure. If the group suite fails, re-open
(`- [x]` to `- [ ]`) every task in the group whose diff the failure touches before you
delegate anything else, so the plan never records a task as done that the suite rejects.

Mechanical checks are not review. Subagents self-report, and self-reports are not
evidence. After the mechanical check passes, read every file the delegated agent
created or modified, then cross-reference what it claimed against what the code
actually does:

```
[ ] Does it work as expected, not just "should work"?
[ ] Does it follow the existing codebase pattern (naming, error handling, layer boundaries)?
[ ] Did the expected result actually come out (not a plausible-sounding substitute)?
[ ] Were the SCOPE requirements and exclusions from the delegation prompt honored?
[ ] Read the executor's `SLOP PASS:` cut list and confirm nothing load-bearing was cut.
[ ] Is this the smallest diff that satisfies the task? If not, send it back with what to drop.
```

The executor's report ends with a `SLOP PASS:` line carrying a per-file cut list with
the category of each cut, or `no cuts`, or `docs-only, prose pass applied`. That line is
a self-report, and this section already said self-reports are not evidence, so confirming
the line is present proves nothing. Open each file it names and look at what left.

The dangerous cuts are exactly the ones the build and the test suite cannot catch,
because nothing exercises them:

- a validation removed from a path no test covers, including anything at a trust boundary
- a `// SAFETY:` or invariant justification removed as "obvious"
- an error branch, a cleanup path, or a data-loss guard removed as "defensive"
- a magic-number derivation comment removed as "restates the code"

A green build after those cuts means the suite never reached them, not that they were
slop. If the cut list names one and you cannot point at the test that would fail without
it, treat the cut as a regression and require it back before flipping the checkbox.
`no cuts` still gets a diff read: an absent cut list is not an absent change.

If you cannot explain what the changed code does, you have not reviewed it:
go back and read it. Never trust a subagent's self-report as a substitute for
reading the diff yourself.

If any QA scenario spawned a resource (process, port, container, temp dir,
browser session), confirm its teardown receipt before treating the task as
verified: a leftover process or bound port is not complete.

Only once the review above passes: edit plan file `- [ ]` → `- [x]`. The successful
Edit is the confirmation, since an Edit whose text does not match fails instead of
landing. Flip the box before the next delegation: `boulder_progress`, the Stop gate, and
a resumed session all read progress from these boxes.

## Completeness Check

After flipping the LAST `- [ ]` → `- [x]`:

**Run the plan's `## Verification` commands**, the project's own full check, and log
each result via `evidence_log`. When the plan lists none, run the project's own build,
lint, and test commands.

Then run a single completeness review yourself: read the plan end to end, read the
plan's full diff, and check that each requirement was implemented and each `Must NOT`
was honored. The verdict is COMPLETE or INCOMPLETE with specifics. You reviewed every
task's diff in 2.3, so a fresh reviewer mostly re-derives your findings; hand the review
to `executor` only when the full diff no longer fits in your remaining context:

```text
Agent(
  subagent_type="oh-my-claudeagent:executor",
  prompt="[five-section completeness review prompt: read plan end-to-end, read diffs,
check each requirement was implemented, check each constraint was honored.
Output: COMPLETE or INCOMPLETE with specifics.]"
)
```

When you have the `advisor` tool, call it once your own verdict is COMPLETE and before
you log it. It has read every delegation and verification in this session and answers
what you missed. A gap it names that the diff confirms makes the verdict INCOMPLETE.

Before logging the verdict, read the plan file's own hash so the Stop gate can
scope the evidence to this exact plan run rather than any `final_verification` entry
that happens to be lying around. Call `boulder_progress` with the plan's `plan_path`
and take `plan_sha256` from its result: it is the SHA-256 of the plan file's current
bytes, and no shell command is needed to compute it. Call it after the last edit to
the plan file, because any later edit changes the hash.

Pass that value as `plan_sha256` on the `final_verification` call:

```
evidence_log(
  evidence_type="final_verification",
  command="completeness review: COMPLETE",
  exit_code=0,
  output_snippet="COMPLETE, all requirements met",
  plan_sha256="<plan_sha256 from boulder_progress>"
)
```

A verdict of "COMPLETE, but..." or "looks good aside from..." counts as
INCOMPLETE: a qualified approval is a rejection. Fix the qualified issue and
re-verify; there is no partial-credit verdict.

On INCOMPLETE: fix the specific gap, re-run the completeness review, log a fresh
`final_verification` entry. Repeat until COMPLETE. This loop is bounded by the
fix-and-rerun cycle itself: it terminates when the gap is actually closed, not
by a retry counter.

The Stop hook enforces this gate: it blocks session end when the plan is fully
checked but no `final_verification` evidence entry (exit_code=0) exists. A logged
verdict opens the gate permanently.

Do not report completion until `final_verification` evidence is logged.

## Evidence Logging Mandate

Use `evidence_log` after every verification command. No evidence, no done.

The `TaskCompleted` hook backs this up, but it does not gate every path to completion:
it fires only when a task is closed through `TaskUpdate` or when a teammate ends its
turn, so a run that never touches the task list is never gated by it. Treat the mandate
as yours to honor rather than as something the hook will catch for you.

Task-list tools are a precondition, not a given. Claude Code provides
`TaskCreate`/`TaskUpdate` by default only on Claude 3.x, Opus 4 through 4.7, Sonnet 4
through 4.6, and Haiku 4.5. Every other model, including the ones the `opus` and `fable`
aliases resolve to on the Anthropic API, goes without them unless
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set in the environment. Without that variable the
task list is unavailable and the `TaskCompleted` hook has nothing to fire on.

Standard pattern:
```
evidence_log(
  evidence_type="...",
  command="...",
  exit_code=0,
  output_snippet="...",
  verified_by="executor"
)
```

Completeness-check evidence call (`plan_sha256` scopes the verdict to this plan's
current bytes, see Completeness Check above):

```
evidence_log(
  evidence_type="final_verification",
  command="completeness review: COMPLETE",
  exit_code=0,
  output_snippet="COMPLETE, all N requirements met, no constraints violated",
  plan_sha256="<plan_sha256 from boulder_progress>"
)
```

Evidence type table:

| Type                 | When                                          |
|----------------------|-----------------------------------------------|
| `build`              | Build/compile command                         |
| `test`               | Test suite run                                |
| `lint`               | Linter or static analysis                     |
| `manual`             | Manual QA scenario                            |
| `final_verification` | End-of-plan completeness verdict (COMPLETE)   |

Session end is blocked until a `final_verification` entry with `exit_code=0` exists.

## Auto-Continue Policy

Do not ask "should I continue" between plan steps. After verification passes →
immediately delegate next task.

After each checkbox flip, write the user a short note: which task finished, what
verified it, and what runs next. Claude Code collapses thinking by default, so
between-tool notes the model writes as thinking stay hidden, and this note is the only
progress a user sees during a long run.

**Pause only when**: plan needs clarification, blocked by external dependency,
critical failure.

At each phase boundary (or, in unphased plans, roughly every few completed
tasks), review the plan's notepad `issues` section via `notepad_read` and
disposition every open entry: schedule it as a task, defer it with a stated
reason, or reject it with a stated reason. Entries left silently unaddressed
accumulate into gaps the completeness check will not catch, since it reviews
the plan's checkboxes, not the notepad.

### Stop Conditions

| Condition    | Signal                                                | Action                                             |
|--------------|-------------------------------------------------------|-----------------------------------------------------|
| **CONTINUE** | Task passes verification AND subsequent tasks unblocked | Proceed immediately                              |
| **ESCALATE** | 2+ tasks in same plan area fail verification          | Ask user whether to run metis re-analysis          |
| **PAUSE**    | 2 consecutive independent task failures               | Document failures, pause, ask user for guidance    |
| **ABORT**    | 3+ consecutive waves with zero net progress           | Stop all work, document state, present to user     |

### Failure Handling

Max 3 retries per task. Blocked after 3 → `notepad_write(plan_name, "issues", ...)`,
continue to independent tasks. After 2+ tasks in same area fail → ask user
whether to run metis re-analysis.

When relaunching a task after a failed executor attempt, the fresh delegation
prompt must carry forward what was already tried and why it failed: the exact
commands/edits attempted and the observed error, not just "try again." A new
agent repeating the same failed approach because it never saw the failure is a
wasted retry, not a fresh angle.

When a relaunched task fails again with the same error, call the `advisor` tool before
the next relaunch, when you have it: it has read both delegations and their reports and
can say whether the task itself is aimed at the wrong place.

A task never moves past unverified into "done." A verification failure is never
dismissed as a false positive without evidence proving the failure itself was
spurious (e.g. a flaky-test rerun that then passes, logged). "That's probably
just flaky" is not evidence.

## MCP Tool Reference

- **`boulder_write`**: Write/update execution metadata (active plan, session ID, worktree path)
- **`boulder_progress`**: Task completion counts and active plan info
- **`evidence_log`**: after every verification command; no evidence, no done
- **`evidence_read`**: Before final report to summarize all results
- **`notepad_write`**: Blockers/audit breadcrumbs (learnings, issues, decisions, problems)
- **`notepad_read`**: Fallback audit notes when relevant to a pending task
- Never `rm -f` on `.omca/state/`: use MCP tools

Only `evidence_log`, `boulder_progress`, and `notepad_write` load eagerly. `boulder_write`, `evidence_read`, `notepad_read`, `ast_search`, and `file_read` are deferred, so hydrate the schema with `ToolSearch({query: "select:<name>", max_results: 1})` before the first call or it fails with an `InputValidationError`.

`boulder_write` is the one to watch: this command requires it before any delegation, so it is the first MCP call of every plan run and a missing-tool error there stops the run at step one. Hydrate it in the same message that reads the plan.

## Critical Rules

- `boulder_write` before delegating; tracks execution metadata
- Read the full plan before delegating
- All five sections in every delegation prompt
- `evidence_log` after every verification command
- `evidence_read` before final report to summarize all results
- Mark plan checkboxes immediately after verification; do not batch
- Never trust subagent claims without independent verification
- Never batch multiple plan tasks in one delegation
- Never use `Bash(claude ...)`: use native `Agent(subagent_type=...)`
