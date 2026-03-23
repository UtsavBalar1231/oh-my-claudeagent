# oh-my-claudeagent Eval Harness

This directory contains task definitions and tooling for evaluating agent behavior.
Automated execution is future work — the current harness documents expected behavior
and enables manual and semi-automated verification.

## Directory Structure

```
tests/evals/
  README.md          — this file
  run-eval.sh        — harness script (reports task inventory)
  tasks/             — task definition files (JSON)
    single-file-edit.json
    multi-file-search.json
    bug-fix.json
    planning.json
    research.json
```

## Task Definition Schema

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

## Running Evals

List all tasks:

```bash
bash tests/evals/run-eval.sh
```

Run a single task manually:

```bash
claude --plugin-dir . -p "$(jq -r '.prompt' tests/evals/tasks/single-file-edit.json)" | tee output.log
```

## pass^k Methodology

To measure consistency, each task should be run k=3 times independently.

- **pass@1**: task passes on at least one of the 3 runs
- **pass^3**: task passes on all 3 runs (strict consistency)

A task that passes pass@1 but not pass^3 indicates flaky behavior worth investigating.

### Running consistency checks

```
just eval-consistency
```

This prints methodology guidance. Automated multi-run execution is future work — for now,
run tasks manually and record pass/fail per trial in a results file.

### Recording results (manual)

Create a `results/` directory under `tests/evals/` and add files named
`<task-name>-trial-N.json` with structure:

```json
{
  "task": "task-name",
  "trial": 1,
  "passed": true,
  "notes": "optional notes"
}
```

Aggregate with:

```bash
jq -s 'group_by(.task) | map({task: .[0].task, trials: length, passed: map(select(.passed)) | length})' \
  tests/evals/results/*.json
```
