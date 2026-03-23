# oh-my-claudeagent Eval Harness

> **Status: scaffolding — execution engine not yet implemented.**

This directory contains task definitions for evaluating agent behavior.
`run-eval.sh` lists available tasks. Automated execution, scoring, and results
aggregation are future work.

## Directory Structure

```
tests/evals/
  README.md          — this file
  run-eval.sh        — lists available task definitions
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

## Running Tasks Manually

List all available tasks:

```bash
bash tests/evals/run-eval.sh
```

Run a single task manually:

```bash
claude --plugin-dir . -p "$(jq -r '.prompt' tests/evals/tasks/single-file-edit.json)" | tee output.log
```

Evaluate the output against the task's `success_criteria` field by hand.

## Writing New Tasks

Add a new `.json` file to `tests/evals/tasks/` following the schema above.
Keep prompts realistic and `success_criteria` observable — avoid criteria that
require automated scoring to verify.
