# Verify-heuristics A/B protocol

This document is written and evidence-logged before any harness code exists.
The report that accompanies this experiment shows the evidence_log timestamps
in order: this protocol first, the harness and corpus after. That ordering is
the pre-registration proof, in place of the "commit before code" convention
this repo normally uses (this task does not commit).

## Question

`scripts/task-completed-verify.sh` gates the `TaskCompleted` hook with two
signals: a keyword regex over the task description (`verify|test|build|
typecheck|lint|validate|fix|implement|refactor|deploy`), and whether
`.omca/evidence/verification-evidence.json` was modified in the last 300
seconds. The 2026-03-15 agent audit called this the weakest link in the hook
corpus. This experiment measures, on real recorded sessions from this
project's own history, whether an alternative candidate beats the current
heuristic by a pre-registered margin.

## Corpus source

Real sessions: `~/.claude/projects/-home-utsav-dev-softs-oh-my-claudeagent/*.jsonl`,
the platform's own transcript store for this repo. Direct JSONL reading is
used for bulk extraction, not `session_search`: building this corpus needs a
full structural scan of every `Agent` tool_use/tool_result pair and every
`evidence_log` tool_use call across ~64MB of transcript, in call order. That
is a different shape of query than `session_search`'s bounded substring
match, which returns capped excerpts around one query term. `session_search`
was used during exploration of this corpus (checking a handful of specific
task descriptions and their surrounding turns) but is not the extraction
mechanism, honestly stated: it is not a fit for this job, not because it was
untried.

**Event definition.** The `TaskCompleted` hook payload carries
`task_description` (`.task_description // .description`) and
`teammate_name`. This matches the `description` field on an `Agent` tool_use
block exactly. A task-completion event, for this experiment, is one `Agent`
tool_use call paired with its `tool_result` in the same transcript file:
`call_ts` = the tool_use record's timestamp, `result_ts` = the paired
tool_result record's timestamp, `description` = `input.description`,
`subagent_type` = `input.subagent_type`.

**Evidence-recency reconstruction.** The real hook checks the mtime of one
shared file, not anything session-scoped. To replay that check against
history, every `mcp__..._evidence_log` tool_use call in the same transcript
file is treated as an mtime-bumping write to that shared file, keyed by its
own timestamp and its `command`/`evidence_type` input fields. For a given
completion event at `result_ts`, `RECENT_EVIDENCE` = true if the nearest
preceding evidence_log call in the same file is within 300 seconds.
**Known limitation, stated up front**: this only sees evidence_log calls
made directly in the main session transcript. A leaf subagent's own
evidence_log calls do not appear in the parent transcript (subagents run in
an isolated context and return only a final result block), so evidence
written by a background subagent mid-flight is invisible to this
reconstruction. This under-counts RECENT_EVIDENCE=true relative to the real
hook in exactly the cases where a subagent verified its own work. That
biases the reconstructed CURRENT candidate toward more false-blocks than the
live hook actually produces — noted, not corrected, because correcting it
would require re-deriving subagent-internal state this corpus does not
contain.

**Timestamp caveat.** In this corpus, `call_ts` and `result_ts` are usually
within tens of milliseconds of each other, including for agents dispatched
in parallel/background per the orchestration protocol. That means the
JSONL's own timestamps do not reliably capture true wall-clock subagent
execution time; they mark when the transcript record was written, not when
the real `TaskCompleted` hook fired for a long-running background agent.
This experiment uses `result_ts` as the proxy completion time regardless,
because it is the only signal on disk. Any candidate's numbers are read as
"measured against transcript-recorded event order," not "measured against
true wall-clock hook firing time."

## Labeling error model

Two labels matter: **true-complete** (the task's own work held up) and
**true-incomplete** (later history shows it needed rework). Neither is
directly recorded anywhere; both are inferred from what happens *after* the
event in the same transcript.

**Proxy rule, frozen before measurement:** for a completion event with
description D at time T in file F, scan every later `Agent` tool_use call in
the same file (call time > T). Compute word-set overlap between D and the
later call's description, after lowercasing and stripping a short stopword
list. If a later call's description shares at least one significant word
with D **and** that later call's own description or prompt contains a
rework-signal token (`fix`, `wrong`, `bug`, `gap`, `missed`, `incomplete`,
`redo`, `revisit`, `broken`, `regression`, `did not`, `actually`), label the
earlier event **true-incomplete**. If no later call shares any significant
word with D, label it **true-complete**. If a later call shares words with D
but carries no rework-signal token, the event is **ambiguous** and is
EXCLUDED from both metrics, not guessed either way — the plan's explicit
requirement. A task can be genuinely reopened for reasons unrelated to the
original task's quality (dependency shifted, scope grew, an adjacent bug was
found by accident); this proxy has no way to distinguish "reopened because
the first pass was wrong" from "reopened because the world moved," which is
exactly why the rework-signal token is required in addition to topical
overlap, and why anything short of that combination is excluded rather than
labeled.

**Direction of the noise.** This proxy is noisy in both directions:
- False true-incomplete (a task gets relabeled complete-but-flagged): a
  later, unrelated call happens to share a word with D and also happens to
  contain a rework-signal token about something else entirely. Rare given
  the word-overlap gate, not zero.
- False true-complete (a task that was actually broken looks complete):
  rework happened in a way this proxy cannot see — a later human-only
  conversation turn with no matching `Agent` call, a fix folded into an
  unrelated task's scope, or rework in a session outside this project's
  five transcript files entirely (e.g., a fix applied from a different
  working directory). This direction is the harder one to catch and is why
  the false-pass metric (which needs true-incomplete events as its
  denominator) is treated as the weaker of the two measurements below.

## Corpus size and synthetic fixtures

Real corpus: all `Agent` tool_use/tool_result pairs across the five
transcript files (`corpus/real_events.json`, extracted by
`extract_corpus.py`). As of this experiment's run, that is on the order of
110+ events before exclusion. Only `description`, `subagent_type`, relative
timestamps, keyword/overlap booleans, and the derived label are stored —
never raw prompt or result text — per the redaction requirement below.

Five synthetic fixtures (`corpus/synthetic_events.json`, hand-authored,
explicitly `"synthetic": true`) cover edge cases the real corpus may not
hit reliably: no-keyword/no-evidence, exact-boundary evidence (301s vs
299s), and a keyword+evidence-present-but-topically-unrelated case, which
is the one case designed to separate CURRENT from the no-new-state
alternative.

**Redaction.** Corpus fixtures store only: file id (not the raw session
UUID path), a redacted sequence index, `description` (already a short
factual title supplied by the orchestrator, e.g. "Compare agent
definitions" — not sensitive), `subagent_type`, seconds-since-previous-
evidence-call, keyword-match booleans, word-overlap-with-later-call
booleans, rework-signal-token booleans, and the derived label. No prompt
text, no tool_result text, no file paths beyond what's already in
`description`.

## Metrics and the one-sided caveat

- **False-block rate** = (true-complete events the candidate blocks) /
  (true-complete events total).
- **False-pass rate** = (true-incomplete events the candidate passes) /
  (true-incomplete events total).

**Pre-registered caveat, fixed now:** if the true-incomplete count (after
exclusions) is below **5**, the false-pass metric is not computed at all —
the experiment reports false-block only. A false-block-only result is
one-sided evidence: it can support keeping the current heuristic or
tightening it further, but it CANNOT justify loosening the gate, because
loosening trades false-blocks for false-passes and this corpus would not
have enough true-incomplete events to show that trade actually held.

## Candidates

1. **CURRENT** — `scripts/task-completed-verify.sh` as it stands: keyword
   regex over `task_description`, OR-gated with evidence-file mtime <= 300s
   (reconstructed per "Evidence-recency reconstruction" above).
2. **NO-NEW-STATE alternative** — same keyword regex, but additionally
   requires at least one significant word shared between the task
   description and the nearest preceding evidence call's `command` field
   (no new state: uses only fields the evidence schema already has today).
3. **SESSION-SCOPED alternative — documented only, not implemented.**
   Matching evidence to the exact task by session id would need: a new
   `session_id` field on every `evidence_log` entry (`evidence.py` +
   `.claude/rules/state-schemas.md`'s evidence schema, both currently
   silent on session identity), and a session id threaded through the
   `TaskCompleted` hook payload, which does not carry one today. That is a
   protect-adjacent, cross-file schema change with no existing consumer.
   This experiment does not implement or measure it; it is named here so
   Stage 3 can point at the cost if a future review asks "why not just do
   the precise thing."
4. **NULL CONTROL** — no gate; every event passes. Included for
   calibration: it shows the ceiling false-pass rate (100% of
   true-incomplete events "pass" because nothing is checked) and the floor
   false-block rate (0%), so the other candidates' numbers have a frame of
   reference.

## Decision thresholds, fixed before measurement

A candidate other than CURRENT is adopted only if **all** of the following
hold on this corpus:
1. True-incomplete count (after exclusion) is >= 5, so the false-pass
   metric is actually computed. Below 5: automatic KEEP CURRENT, regardless
   of any false-block number — one-sided evidence cannot justify loosening.
2. The candidate's false-pass rate is <= CURRENT's false-pass rate (never
   regress on catching true-incomplete events).
3. The candidate's false-block rate is at least 5 percentage points lower
   than CURRENT's (absolute), on the same corpus.

If a candidate clears all three, Stage 3 implements it in
`scripts/task-completed-verify.sh`, updates the bats suite, and re-runs the
full Stop-hook disjointness matrix. If nothing clears all three,
`RESULTS.md` records the decision and no hook file changes.
