#!/usr/bin/env bash
# Basic eval harness — reads task definitions, reports expected format
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
echo "To run: claude -p 'task prompt here' --plugin-dir . | tee output.log"
echo "Manual verification required — automated execution is future work"
