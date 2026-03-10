#!/bin/bash

INPUT=$(cat)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
RALPH_STATE="${STATE_DIR}/ralph-state.json"

if [[ ! -f "${RALPH_STATE}" ]]; then
	exit 0
fi

STOP_HOOK_ACTIVE=$(echo "${INPUT}" | jq -r '.stop_hook_active // false' 2>/dev/null)
if [[ "${STOP_HOOK_ACTIVE}" == "true" ]]; then
	exit 0
fi

STATUS=$(jq -r '.status // "inactive"' "${RALPH_STATE}" 2>/dev/null)

if [[ "${STATUS}" != "active" ]]; then
	exit 0
fi

INCOMPLETE=$(jq '[.tasks[]? | select(.status != "completed" and .status != "verified")] | length' "${RALPH_STATE}" 2>/dev/null || echo "0")

if [[ "${INCOMPLETE}" -gt 0 ]]; then
	echo '{"decision": "block", "reason": "[RALPH PERSISTENCE] Ralph mode is active with incomplete tasks. Continue working until oracle verification passes."}'
fi

exit 0
