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

# Allow stop if a question is pending — user needs to answer
QUESTION_FILE="${STATE_DIR}/pending-question.json"
if [[ -f "${QUESTION_FILE}" ]]; then
	Q_TS=$(jq -r '.timestamp // 0' "${QUESTION_FILE}" 2>/dev/null)
	Q_TS=${Q_TS:-0}
	NOW=$(date +%s)
	DIFF=$((NOW - Q_TS))
	if [[ ${DIFF} -lt 300 ]]; then
		rm -f "${QUESTION_FILE}"
		exit 0  # Allow stop — question pending
	fi
	rm -f "${QUESTION_FILE}"
fi

# Stagnation detection
MAX_STAGNATION=3
# Portable hash — md5sum (GNU/Linux) vs md5 (macOS BSD)
if command -v md5sum &>/dev/null; then
	TASK_HASH=$(jq -r '[.tasks[]? | .status] | sort | join(",")' "${RALPH_STATE}" 2>/dev/null | md5sum | cut -d' ' -f1)
else
	TASK_HASH=$(jq -r '[.tasks[]? | .status] | sort | join(",")' "${RALPH_STATE}" 2>/dev/null | md5 | cut -d' ' -f4)
fi

LAST_HASH=$(jq -r '.last_task_hash // ""' "${RALPH_STATE}" 2>/dev/null)
STAGNATION=$(jq -r '.stagnation_count // 0' "${RALPH_STATE}" 2>/dev/null)

if [[ "${TASK_HASH}" == "${LAST_HASH}" ]]; then
	STAGNATION=$((STAGNATION + 1))
else
	STAGNATION=0
fi

# Update state
jq --arg hash "${TASK_HASH}" --argjson count "${STAGNATION}" \
	'.last_task_hash = $hash | .stagnation_count = $count' \
	"${RALPH_STATE}" > "${RALPH_STATE}.tmp" && \
	mv "${RALPH_STATE}.tmp" "${RALPH_STATE}"

if [[ ${STAGNATION} -ge ${MAX_STAGNATION} ]]; then
	# Allow stop — no progress after 3 attempts
	exit 0
fi

INCOMPLETE=$(jq '[.tasks[]? | select(.status != "completed" and .status != "verified")] | length' "${RALPH_STATE}" 2>/dev/null || echo "0")

if [[ "${INCOMPLETE}" -gt 0 ]]; then
	echo '{"hookSpecificOutput": {"hookEventName": "Stop", "decision": {"behavior": "block"}, "reason": "[RALPH PERSISTENCE] Ralph mode is active with incomplete tasks. Continue working until oracle verification passes."}}'
fi

exit 0
