#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"
STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

TIMESTAMP=$(date -Iseconds)

ERROR_TYPE=$(echo "${INPUT}" | jq -r '.error // "unknown"' 2>/dev/null)
ERROR_DETAILS=$(echo "${INPUT}" | jq -r '.error_details // ""' 2>/dev/null)
LAST_MSG=$(echo "${INPUT}" | jq -r '.last_assistant_message // ""' 2>/dev/null)

# Detect active persistence modes
RALPH_ACTIVE=false
ULTRAWORK_ACTIVE=false

RALPH_STATE="${STATE_DIR}/ralph-state.json"
ULTRAWORK_STATE="${STATE_DIR}/ultrawork-state.json"

if [[ -f "${RALPH_STATE}" ]]; then
	STATUS=$(jq -r '.status // "inactive"' "${RALPH_STATE}" 2>/dev/null)
	[[ "${STATUS}" == "active" ]] && RALPH_ACTIVE=true
fi

if [[ -f "${ULTRAWORK_STATE}" ]]; then
	STATUS=$(jq -r '.status // "inactive"' "${ULTRAWORK_STATE}" 2>/dev/null)
	[[ "${STATUS}" == "active" ]] && ULTRAWORK_ACTIVE=true
fi

# Build log entry
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
echo "${LOG_ENTRY}" >> "${LOG_FILE}"

exit 0
