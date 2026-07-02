# Verify-heuristics A/B results

Ran per `PROTOCOL.md` (written and evidence-logged first) against
`corpus/real_events.json` (115 events extracted from this project's own
recorded transcripts by `extract_corpus.py`) plus `corpus/synthetic_events.json`
(5 hand-authored edge fixtures, explicitly `"synthetic": true`). Full numbers
in `results.json`, produced by `run_experiment.py`.

## Corpus

| | count |
|---|---|
| total events | 120 (115 real + 5 synthetic) |
| true-complete | 76 |
| true-incomplete | 25 |
| ambiguous (excluded) | 19 |

Pre-registered minimum for the false-pass metric to be computed: 5
true-incomplete events. 25 clears it, so both metrics are reportable this
run (the one-sided caveat in PROTOCOL.md does not apply here).

## Numbers

| candidate | false-block rate | false-pass rate |
|---|---|---|
| current | 6.58% (5/76) | 76.00% (19/25) |
| no_new_state | 6.58% (5/76) | 72.00% (18/25) |
| null_control (calibration) | 0.00% (0/76) | 100.00% (25/25) |

`session_scoped` was not run — it is documented-only in PROTOCOL.md, not
implemented, because it needs a `session_id` field on evidence entries that
does not exist today.

## Decision

**KEEP CURRENT.** No candidate cleared all three pre-registered thresholds
from PROTOCOL.md:

1. True-incomplete count >= 5 — cleared (25).
2. Candidate's false-pass rate <= current's — `no_new_state` clears this
   (72% <= 76%).
3. Candidate's false-block rate at least 5 percentage points lower than
   current's — `no_new_state` does NOT clear this: both candidates block
   the exact same 5 true-complete events (6.58% vs 6.58%, 0pp
   improvement). The one synthetic fixture built specifically to separate
   the two candidates (evidence present but topically unrelated to the
   task) never occurred in the real corpus at a rate that moved the
   false-block number.

No hook file changes follow from this run. `scripts/task-completed-verify.sh`
is unchanged; no bats update or Stop-hook disjointness re-run is needed.

## What this run does and does not show

`no_new_state`'s lower false-pass rate (72% vs 76%, a 3-event swing: it
additionally catches true-incomplete events where recent evidence existed
but its command text didn't overlap with the task's own words) is a real
signal in the direction the audit hoped for, but it doesn't clear the
false-block bar this experiment pre-registered, and one metric moving in
the right direction while the other stays flat isn't the two-out-of-two
result the thresholds require.

The false-pass rate itself — 76% even under CURRENT — reads alarming in
isolation, but the labeling error model in PROTOCOL.md explains most of
that: "true-incomplete" here means a *later* Agent call in the same
transcript shared a topical word with the earlier task's description and
carried an explicit rework-signal token ("wrong", "bug", "gap", "missed",
"incomplete", "redo", "revisit", "broken", "regression"). Most of what
`TaskCompleted` is actually gating — did the agent run `evidence_log` at
all — has nothing to do with whether a later, unrelated review found scope
gaps. A high false-pass rate under this proxy does not mean the hook is
failing at its actual job; it means "later revisited for any reason,
labeled with a rework word" is a broad net, exactly the noise the protocol
called out before measuring. This is the harder-to-catch direction named in
PROTOCOL.md's error model (false true-complete): the proxy has no way to
tell "the hook let something broken through" apart from "a later task in
this transcript touched a related area and used a word like 'gap' for
unrelated reasons." Reading the false-pass number as "the hook fails to
catch problems 76% of the time" would overstate what this experiment can
actually show.

## What would change this

- A larger or differently-sourced corpus (this repo's transcripts are
  meta-work about hooks and agents, which is a narrow domain; a
  general-purpose project's transcripts might show a different pattern
  entirely).
- A tighter labeling proxy — human-reviewed labels instead of the
  word-overlap-plus-rework-token heuristic would shrink the 19 ambiguous
  exclusions and might reveal a false-block gap the current proxy is too
  noisy to see.
- If `no_new_state`'s false-block rate improves independently (e.g. after
  a corpus refresh with more evidence/task mismatches), it clears
  threshold 3 without any change to threshold 1 or 2, at which point
  Stage 3 (hook change + bats update + disjointness re-run) would apply.
