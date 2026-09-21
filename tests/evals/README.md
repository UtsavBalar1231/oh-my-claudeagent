# oh-my-claudeagent eval harness

`run-eval.sh` lists the available fixtures. There is no automated runner: a trial is one
live `claude -p` turn, launched by hand inside a throwaway git worktree, and scored from
the diff that turn left behind. This file is the procedure. Follow it verbatim so two
trials taken weeks apart remain comparable.

## Directory structure

```
tests/evals/
  README.md          this file
  run-eval.sh        lists the available task definitions
  tasks/             task definition files (JSON)
    single-file-edit.json
    multi-file-search.json
    bug-fix.json
    planning.json
    research.json
    diff-latitude.json
  results/           trial records, one JSON file per trial
    turn-count.txt   running total of live trial turns
```

## Task definition schema

Each task file is a JSON object:

```json
{
  "name": "human-readable task name",
  "prompt": "the prompt sent to the agent",
  "expected_tools": ["Read", "Edit", "Bash"],
  "success_criteria": "what a correct completion looks like",
  "category": "edit | search | bugfix | planning | research"
}
```

`expected_tools` names tools that are actually present in the default tool set on this
platform. A tool that is withheld at runtime, such as Grep on Linux, must not appear
there: a fixture that expects an unavailable tool scores a correct answer as wrong.

`success_criteria` must be checkable against the worktree after the turn. Where a clause
is mechanical (a file exists, a string is present, a command exits 0), check it
mechanically rather than by reading the model's own summary.

## Diff-size targets

Only `diff-latitude.json` carries a diff-size target, and it is the only fixture any
`lines_added` figure is asserted against. The other fixtures either dictate their own
edit exactly or produce no code at all, so their line counts measure nothing.

`diff-latitude` target: a correct solution adds about five lines to
`tests/evals/run-eval.sh`. One argument check plus a skip inside the existing loop is
enough. Added configuration knobs, a usage function, argument validation beyond the one
flag, helper abstractions, or comments narrating the loop all push the count toward
sixty while passing the same check. The fixture prompt says nothing about brevity on
purpose: whether the plugin's own prompts produce restraint is what later measurements
test, so telling the model to be brief would destroy the signal.

## Isolation procedure

Every fixture mutates tracked files. Never run one with this checkout as the working
directory. Build a throwaway worktree, run the turn inside it, read the diff, then
remove it.

```bash
REPO=/home/utsav/dev/softs/oh-my-claudeagent
WT=$(mktemp -d "${TMPDIR:-/tmp}/eval-XXXXXX")/wt
COMMIT=$(git -C "$REPO" rev-parse HEAD)
FIXTURE=diff-latitude

git -C "$REPO" worktree add --detach "$WT" "$COMMIT"

# Fixtures being repaired are uncommitted, so read the prompt from the main checkout.
PROMPT=$(jq -r '.prompt' "$REPO/tests/evals/tasks/${FIXTURE}.json")

# Optional: copy a candidate prompt file in, to measure one edit against the baseline.
# cp "$REPO/agents/executor.md" "$WT/agents/executor.md"

# A file created by the run is newer than this marker; the checkout is not.
sleep 1; touch "$WT/../marker"; sleep 1

cd "$WT"
START=$(date +%s)
env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
    -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
    -u CLAUDE_CODE_ENTRYPOINT -u CLAUDECODE -u CLAUDE_PID -u CLAUDE_EFFORT \
    -u CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR -u CLAUDE_CODE_SESSION_ATTENDED \
    -u CLAUDE_CODE_EXECPATH -u AI_AGENT \
  timeout 900 \
  claude -p "$PROMPT" --plugin-dir "$WT" --permission-mode bypassPermissions \
    --debug-file debug.log --verbose \
  > trial.log 2>stderr.log
EXIT=$?
DURATION=$(( $(date +%s) - START ))

git -C "$WT" diff --shortstat
git -C "$WT" diff --numstat
git -C "$WT" diff > diff.patch

cd "$REPO"
git worktree remove --force "$WT"
```

Every detail in that snippet is load-bearing:

- `--plugin-dir "$WT"` points the run at the worktree's own copy of the plugin. The
  installed marketplace copy also loads in a `claude -p` session. Confirm which root
  served the run by reading the `skillsPath` value from the debug log, and record it in
  the trial record. Measured on this harness, `--plugin-dir` wins: every baseline trial
  reported the worktree's own `skills` directory.
- `--permission-mode bypassPermissions`, not `acceptEdits`. Under `acceptEdits` the
  client refuses an Edit to a hook script belonging to a loaded plugin, and in headless
  mode that refusal is final, so `single-file-edit` and `bug-fix` can never pass.
  Bypass mode is safe here only because the run is confined to a throwaway worktree.
  Apply it to every fixture and every arm, so it cannot favour one arm.
- The `env -u` list is mandatory. A nested `claude -p` inherits the parent session's
  identity and messaging variables, which pulls in the parent project's settings and
  makes the run something other than a fresh session. Dropping `CLAUDE_CODE_SESSION_ID`
  in particular: a run that inherited it has been observed alongside the parent
  project's plan binding vanishing from `.omca/state/boulder.json`.
- The marker file is what separates a file the run created from the checkout itself.
  `git status` cannot do this job alone, because a run may write its output under
  `.omca/` or `.claude/`, both of which are gitignored, and the run then reads as having
  produced nothing. Search with `find "$WT" -newer marker` when a criterion asks whether
  a file was written.
- The worktree is the working directory, so the run's hooks write state under the
  worktree's own `.omca/` and never touch this checkout's.
- The worktree lives outside the repository. A worktree under the repo would be picked
  up by file searches and by `git status`.
- `diff.patch` is kept so a trial can be re-scored without spending another live turn.
  Two baseline fixtures were misscored by a scorer that was too narrow, and without a
  saved diff the only remedy is a rerun.

After a batch, print `jq '.bindings' .omca/state/boulder.json` from the main checkout
and confirm this session's binding survived.

The worktree does not contain every side effect. The `planning` fixture asks for a plan
written to a file, and a run may write it to `~/.claude/plans/` rather than inside the
worktree, where removing the worktree will not reach it. After a batch that included
`planning`, list `~/.claude/plans/`, delete the files the trials created, and confirm
nothing else in that directory changed. Scoring already looks in both places, so a plan
written outside the worktree still scores correctly; it is the cleanup that has to be
done by hand.

Trials run sequentially. Parallel trials contend for machine resources and rate limits,
which shows up as timeouts rather than as a model result.

## Trial records

One JSON file per trial under `tests/evals/results/<label>/`, where `<label>` names the
batch (`baseline`, or the label of the measurement being run). Fields:

| Field | Meaning |
|---|---|
| `fixture` | the task file's `name` |
| `arm` | opaque arm label, `A` or `B` |
| `commit` | the commit the worktree was built from |
| `candidate_file` | path of the prompt file copied into the worktree, or null |
| `trial_index` | 1, 2 or 3 within this arm and fixture |
| `exit_code` | exit status of the `claude -p` turn |
| `lines_added` | insertions from `git diff --shortstat` inside the worktree |
| `lines_deleted` | deletions from the same command |
| `files_touched` | number of rows from `git diff --numstat` inside the worktree |
| `verdict` | `pass` or `fail` against the fixture's `success_criteria` |
| `verdict_reason` | one line, naming the criterion that decided it |
| `plugin_root` | the `skillsPath` the run actually loaded from |
| `duration_seconds` | wall clock for the turn |

`arm` is opaque on purpose. The mapping from arm label to what that arm contained lives
in a file outside `results/`, so a verdict can be assigned without knowing which arm is
the candidate.

A verdict comes from the worktree's resulting diff and from the turn's output checked
against `success_criteria`. It never comes from the model's own claim of success: a turn
that reports a fix and leaves no diff is a `fail`.

Score behavior, never the shape of the solution. A check that matches a list of accepted
constructs fails any correct answer written a different way, and that failure is
indistinguishable from a model failure once the worktree is gone. Prefer running the
changed code and comparing what it does: for the `bug-fix` fixture, feed
`keyword-detector.sh` a standalone mention and a substring mention and compare the
announcements, rather than grepping the diff for a boundary construct. Before trusting a
new scorer, exercise it against a synthetic worktree with both a positive and a negative
case, which costs no live turn.

`results/turn-count.txt` holds a single integer, the running total of live trial turns
across every measurement. Increment it by one per trial, whatever the verdict. Later
measurements switch from per-task to batched measurement once that total reaches a
threshold, so an unrecorded turn makes that decision wrong.

## Terminal states

A fixture that passes three of three trials in the baseline is qualified. A fixture
short of three of three is disqualified, recorded with its reason in
`results/baseline/summary.json`, and no later measurement may depend on it. A
disqualification reason states whether the fixture itself is hard or the scorer was at
fault, so a later reader can tell which disqualifications are worth revisiting. Repair a
fixture only where it is mechanically unfair: an absent target, a withheld tool. Never
weaken `success_criteria` to make a fixture pass.

If the first two fixtures of a batch fail every trial for the same reason and that
reason is not the model, the harness is broken. Stop, fix the harness, restart the
batch, and do not spend the remaining turns.

## Writing new tasks

Add a `.json` file to `tests/evals/tasks/` following the schema above. `run-eval.sh`
picks it up from the glob with no change. Keep prompts realistic, keep
`success_criteria` checkable against the worktree, and check any `expected_tools` entry
against the tools actually available on this platform.
