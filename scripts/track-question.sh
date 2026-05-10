#!/bin/bash
# PostToolUse hook, matcher: AskUserQuestion
# Records that a question is pending so ralph-persistence.sh can allow stop
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
TIMESTAMP=$(date +%s)
SESSION_ID=$(resolve_session_id)
tmp=$(mktemp)
jq -nc --arg ts "${TIMESTAMP}" --arg sid "${SESSION_ID}" \
	'{"pending":true,"timestamp":($ts|tonumber),"session_id":$sid}' > "${tmp}"
mv "${tmp}" "${STATE_DIR}/pending-question.json"
exit 0
