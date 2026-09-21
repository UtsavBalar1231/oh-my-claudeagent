#!/usr/bin/env bash
# Lists the task definitions under tasks/. Trials are run by hand, see README.md.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TASKS_DIR="${SCRIPT_DIR}/tasks"

echo "=== oh-my-claudeagent Eval Harness ==="
echo "Tasks found: $(ls "${TASKS_DIR}"/*.json 2>/dev/null | wc -l)"
for task in "${TASKS_DIR}"/*.json; do
    name=$(jq -r '.name' "${task}")
    category=$(jq -r '.category' "${task}")
    echo "  [$category] $name"
done
echo ""
echo "To run a trial, follow the isolation procedure in tests/evals/README.md."
echo "Never run a fixture with this checkout as the working directory."
