#!/bin/bash

# TeammateIdle hook — two distinct response mechanisms:
#   exit 2            → "block idle transition, keep teammate working" (ralph/ultrawork)
#   {"continue":false} → "stop the teammate entirely" (stalled agent timeout)

INPUT=$(cat)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
BLOCK_EXIT_CODE=2

# 1. If ralph/ultrawork active → exit 2 (keep working, don't go idle)
for MODE_FILE in ralph-state.json ultrawork-state.json; do
	if [[ -f "${STATE_DIR}/${MODE_FILE}" ]]; then
		STATUS=$(jq -r '.status // "inactive"' "${STATE_DIR}/${MODE_FILE}" 2>/dev/null || echo "")
		if [[ -z "${STATUS}" ]]; then
			continue
		fi
		if [[ "${STATUS}" == "active" ]]; then
			echo "Persistence mode is active. Continue working." >&2
			exit "${BLOCK_EXIT_CODE}"
		fi
	fi
done

# 2. Stall detection — terminate agents that exceed timeout
TIMEOUT_SECS="${OMCA_AGENT_TIMEOUT_SECS:-600}"
SUBAGENTS_FILE="${STATE_DIR}/subagents.json"

if [[ -f "${SUBAGENTS_FILE}" ]]; then
	TEAMMATE_NAME=$(echo "${INPUT}" | jq -r '.teammate_name // .agent_name // ""' 2>/dev/null)
	NOW=$(date +%s)

	# Find the most recent active agent matching the teammate (or any active agent)
	if [[ -n "${TEAMMATE_NAME}" ]]; then
		STARTED_AT=$(jq -r --arg name "${TEAMMATE_NAME}" \
			'[.active[]? | select(.name == $name or .agent_type == $name) | .startedAt // .timestamp // ""] | last // ""' \
			"${SUBAGENTS_FILE}" 2>/dev/null)
	else
		STARTED_AT=$(jq -r \
			'[.active[]? | .startedAt // .timestamp // ""] | last // ""' \
			"${SUBAGENTS_FILE}" 2>/dev/null)
	fi

	if [[ -n "${STARTED_AT}" && "${STARTED_AT}" != "null" ]]; then
		# Portable ISO-to-epoch — date -d is GNU-only; python3 works on macOS + Linux
		STARTED_EPOCH=$(python3 -c "from datetime import datetime,timezone; print(int(datetime.fromisoformat('${STARTED_AT}'.replace('Z','+00:00')).timestamp()))" 2>/dev/null \
			|| date -d "${STARTED_AT}" +%s 2>/dev/null \
			|| echo "${STARTED_AT}")
		if [[ "${STARTED_EPOCH}" =~ ^[0-9]+$ ]]; then
			ELAPSED=$(( NOW - STARTED_EPOCH ))
			if [[ "${ELAPSED}" -gt "${TIMEOUT_SECS}" ]]; then
				printf '{"continue": false, "stopReason": "Agent exceeded timeout (%ds elapsed, %ds limit)"}\n' \
					"${ELAPSED}" "${TIMEOUT_SECS}"
				exit 0
			fi
		fi
	fi
fi

# 3. No mode active, no stall → normal idle behavior
exit 0
