#!/bin/bash

INPUT=$(cat)

SUBAGENT_TYPE=$(echo "${INPUT}" | jq -r '.tool_input.subagent_type // "unknown"' 2>/dev/null)
SUBAGENT_PROMPT_FULL=$(echo "${INPUT}" | jq -r '.tool_input.prompt // ""' 2>/dev/null)
SUBAGENT_PROMPT="${SUBAGENT_PROMPT_FULL:0:200}"
SUBAGENT_MODEL=$(echo "${INPUT}" | jq -r '.tool_input.model // "default"' 2>/dev/null)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"

mkdir -p "${STATE_DIR}" "${LOG_DIR}"

TIMESTAMP=$(date -Iseconds)
# Portable millisecond epoch — %N is GNU-only (broken on macOS BSD date)
SPAWN_EPOCH="$(date +%s)$(printf '%03d' $((RANDOM % 1000)))"
SPAWN_ID="spawn-${SPAWN_EPOCH}"

SUBAGENTS_FILE="${STATE_DIR}/subagents.json"
if [[ ! -f "${SUBAGENTS_FILE}" ]]; then
	echo '{"active":[],"completed":[]}' >"${SUBAGENTS_FILE}"
fi

TMP_FILE=$(mktemp)
jq --arg id "${SPAWN_ID}" \
	--arg type "${SUBAGENT_TYPE}" \
	--arg model "${SUBAGENT_MODEL}" \
	--arg prompt "${SUBAGENT_PROMPT}" \
	--arg ts "${TIMESTAMP}" \
	'.active += [{"id": $id, "type": $type, "model": $model, "promptPreview": $prompt, "startedAt": $ts, "status": "running"}]' \
	"${SUBAGENTS_FILE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${SUBAGENTS_FILE}"

# Signal to agent-usage-reminder that delegation has occurred
AGENT_USAGE="${STATE_DIR}/agent-usage.json"
[[ -f "${AGENT_USAGE}" ]] && { TMP2=$(mktemp); jq '.agentUsed = true' "${AGENT_USAGE}" >"${TMP2}" && mv "${TMP2}" "${AGENT_USAGE}"; }

LOG_FILE="${LOG_DIR}/subagents.jsonl"
jq -nc --arg id "${SPAWN_ID}" --arg type "${SUBAGENT_TYPE}" --arg model "${SUBAGENT_MODEL}" --arg ts "${TIMESTAMP}" \
	'{event: "subagent_spawn", id: $id, type: $type, model: $model, timestamp: $ts}' >>"${LOG_FILE}"

SESSION_STATE="${STATE_DIR}/session.json"
if [[ -f "${SESSION_STATE}" ]]; then
	TMP_FILE=$(mktemp)
	jq --arg id "${SPAWN_ID}" --arg type "${SUBAGENT_TYPE}" \
		'.subagents += [{"id": $id, "type": $type, "status": "running"}]' \
		"${SESSION_STATE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${SESSION_STATE}"
fi

ESCAPED=$(printf '%s' "Subagent ${SUBAGENT_TYPE} (${SPAWN_ID}) spawned with model ${SUBAGENT_MODEL}" | jq -Rs .)
printf '%s\n' "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": ${ESCAPED}}}"
