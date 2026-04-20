#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

TIMESTAMP=$(date -Iseconds)

ERROR_TYPE=$(jq -r '.error // "unknown"' <<< "${HOOK_INPUT}")
ERROR_DETAILS=$(jq -r '.error_details // ""' <<< "${HOOK_INPUT}")
LAST_MSG=$(jq -r '.last_assistant_message // ""' <<< "${HOOK_INPUT}")

RALPH_ACTIVE=false
ULTRAWORK_ACTIVE=false

mode_is_active "ralph" "${STATE_DIR}" && RALPH_ACTIVE=true
mode_is_active "ultrawork" "${STATE_DIR}" && ULTRAWORK_ACTIVE=true

if [[ "${RALPH_ACTIVE}" == "true" || "${ULTRAWORK_ACTIVE}" == "true" ]]; then
	ACTIVE_MODE="ralph"
	[[ "${ULTRAWORK_ACTIVE}" == "true" ]] && ACTIVE_MODE="ultrawork"
	[[ "${RALPH_ACTIVE}" == "true" && "${ULTRAWORK_ACTIVE}" == "true" ]] && ACTIVE_MODE="ralph+ultrawork"

	LOG_ENTRY=$(jq -nc \
		--arg ts "${TIMESTAMP}" \
		--arg err "${ERROR_TYPE}" \
		--arg details "${ERROR_DETAILS}" \
		--arg msg "${LAST_MSG}" \
		--arg mode "${ACTIVE_MODE}" \
		'{event: "stop_failure", timestamp: $ts, error: $err, error_details: $details, last_assistant_message: $msg, warning: ("WARNING: persistence mode was interrupted by API error: " + $err), active_mode: $mode}')
else
	LOG_ENTRY=$(jq -nc \
		--arg ts "${TIMESTAMP}" \
		--arg err "${ERROR_TYPE}" \
		--arg details "${ERROR_DETAILS}" \
		--arg msg "${LAST_MSG}" \
		'{event: "stop_failure", timestamp: $ts, error: $err, error_details: $details, last_assistant_message: $msg}')
fi

LOG_FILE="${LOG_DIR}/stop-failures.jsonl"
echo "${LOG_ENTRY}" >>"${LOG_FILE}"

exit 0
