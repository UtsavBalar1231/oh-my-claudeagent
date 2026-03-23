#!/bin/bash
# PostToolUse hook, matcher: AskUserQuestion
# Records that a question is pending so ralph-persistence.sh can allow stop
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
TIMESTAMP=$(date +%s)
echo "{\"pending\":true,\"timestamp\":${TIMESTAMP}}" > "${STATE_DIR}/pending-question.json"
exit 0
