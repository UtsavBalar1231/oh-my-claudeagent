#!/bin/bash

# TeammateIdle hook — two distinct response mechanisms:
#   exit 2            → "block idle transition, keep teammate working" (ralph/ultrawork)
#   {"continue":false} → "stop the teammate entirely" (stalled agent timeout)
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
# 2 — platform exit code blocking TeammateIdle; exit 0 allows idle, exit 2 keeps working.
BLOCK_EXIT_CODE=2

for MODE_NAME in ralph ultrawork; do
	if mode_is_active "${MODE_NAME}" "${STATE_DIR}"; then
		echo "Persistence mode is active. Continue working." >&2
		exit "${BLOCK_EXIT_CODE}"
	fi
done

TIMEOUT_SECS="${OMCA_AGENT_TIMEOUT_SECS:-600}"
SUBAGENTS_FILE="${STATE_DIR}/subagents.json"

if [[ -f "${SUBAGENTS_FILE}" ]]; then
	TEAMMATE_NAME=$(jq -r '.teammate_name // .agent_name // ""' <<< "${HOOK_INPUT}")
	NOW=$(date +%s)

	if [[ -n "${TEAMMATE_NAME}" ]]; then
		STARTED_EPOCH=$(jq -r --arg name "${TEAMMATE_NAME}" \
			'[.active[]? | select(.type == $name or .type == ("oh-my-claudeagent:" + $name))] | .[0] | .started_epoch // 0' \
			"${SUBAGENTS_FILE}" 2>/dev/null)
	else
		STARTED_EPOCH=$(jq -r \
			'[.active[]? | .started_epoch // 0] | .[0] // 0' \
			"${SUBAGENTS_FILE}" 2>/dev/null)
	fi

	if [[ -n "${STARTED_EPOCH}" && "${STARTED_EPOCH}" != "null" && "${STARTED_EPOCH}" != "0" ]]; then
		if [[ "${STARTED_EPOCH}" =~ ^[0-9]+$ ]]; then
			ELAPSED=$((NOW - STARTED_EPOCH))
			if [[ "${ELAPSED}" -gt "${TIMEOUT_SECS}" ]]; then
				printf '{"continue": false, "stopReason": "Agent exceeded timeout (%ds elapsed, %ds limit)"}\n' \
					"${ELAPSED}" "${TIMEOUT_SECS}"
				exit 0
			fi
		fi
	fi
fi

exit 0
