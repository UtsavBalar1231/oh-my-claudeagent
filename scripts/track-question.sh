#!/bin/bash
# PostToolUse hook, matcher: AskUserQuestion
# Records that a question is pending so ralph-persistence.sh can allow stop
PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
mkdir -p "${STATE_DIR}"
TIMESTAMP=$(date +%s)
echo "{\"pending\":true,\"timestamp\":${TIMESTAMP}}" > "${STATE_DIR}/pending-question.json"
exit 0
