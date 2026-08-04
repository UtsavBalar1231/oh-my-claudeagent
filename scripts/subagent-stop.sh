#!/bin/bash
# Remove the finished subagent's entry from subagent-models.json so the
# statusline's active-agent count reflects live subagents, not every agent
# ever spawned this session. Counterpart to subagent-start.sh's upsert;
# SessionStart's reset remains the backstop for entries a crash leaves behind.

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

_HOOK_START=$(epoch_ns)

AGENT_ID=$(jq -r '.agent_id // ""' <<< "${HOOK_INPUT}")
MODELS_FILE="${HOOK_STATE_DIR}/subagent-models.json"

if [[ -n "${AGENT_ID}" && -f "${MODELS_FILE}" ]]; then
	MODELS_TMP=$(mktemp) || log_hook_error "mktemp failed for subagent-models.json" "subagent-stop.sh"
	if [[ -n "${MODELS_TMP}" ]] && jq --arg id "${AGENT_ID}" 'del(.[$id])' "${MODELS_FILE}" > "${MODELS_TMP}" 2>/dev/null; then
		mv "${MODELS_TMP}" "${MODELS_FILE}" || log_hook_error "mv failed for subagent-models.json" "subagent-stop.sh"
	else
		rm -f "${MODELS_TMP}"
		log_hook_error "jq delete failed for subagent-models.json agent_id=${AGENT_ID}" "subagent-stop.sh"
	fi
fi

hook_timing_log "${_HOOK_START}"
exit 0
