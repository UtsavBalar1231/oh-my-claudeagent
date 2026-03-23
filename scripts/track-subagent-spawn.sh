#!/bin/bash

_HOOK_START=$(date +%s%N 2>/dev/null || date +%s)

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"
STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

SUBAGENT_TYPE=$(echo "${INPUT}" | jq -r '.tool_input.subagent_type // "unknown"' 2>/dev/null)
SUBAGENT_PROMPT_FULL=$(echo "${INPUT}" | jq -r '.tool_input.prompt // ""' 2>/dev/null)
SUBAGENT_PROMPT="${SUBAGENT_PROMPT_FULL:0:200}"
SUBAGENT_MODEL=$(echo "${INPUT}" | jq -r '.tool_input.model // "default"' 2>/dev/null)

TIMESTAMP=$(date -Iseconds)
# Portable pseudo-unique ID (seconds + random noise — not true milliseconds)
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

SESSION_ID="unknown"
SESSION_STATE="${STATE_DIR}/session.json"
if [[ -f "${SESSION_STATE}" ]]; then
	SESSION_ID=$(jq -r '.sessionId // "unknown"' "${SESSION_STATE}" 2>/dev/null)
fi

LOG_FILE="${LOG_DIR}/subagents.jsonl"
jq -nc --arg id "${SPAWN_ID}" --arg type "${SUBAGENT_TYPE}" --arg model "${SUBAGENT_MODEL}" --arg ts "${TIMESTAMP}" \
	--arg session_id "${SESSION_ID}" \
	'{event: "subagent_spawn", id: $id, type: $type, model: $model, timestamp: $ts, spawned_at: $ts, parent_session_id: $session_id}' >>"${LOG_FILE}"

SESSION_STATE="${STATE_DIR}/session.json"
if [[ -f "${SESSION_STATE}" ]]; then
	TMP_FILE=$(mktemp)
	jq --arg id "${SPAWN_ID}" --arg type "${SUBAGENT_TYPE}" \
		'.subagents += [{"id": $id, "type": $type, "status": "running"}]' \
		"${SESSION_STATE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${SESSION_STATE}"
fi

# --- Routing validation (advisory only) ---
ROUTING_CONTEXT=""

# Read cached catalog (written by agents_list() MCP tool)
CATALOG_FILE="${STATE_DIR}/agent-catalog.json"
CATEGORIES_FILE="$(dirname "$0")/../servers/categories.json"

if [[ -f "${CATALOG_FILE}" ]] && [[ -f "${CATEGORIES_FILE}" ]]; then
	# Extract agent name, normalize to lowercase
	AGENT_NAME=$(echo "${SUBAGENT_TYPE##*:}" | tr '[:upper:]' '[:lower:]')

	# Look up agent's preferred_category → expected model
	PREFERRED_CAT=$(jq -r --arg name "${AGENT_NAME}" \
		'.[] | select(.name == $name) | .preferred_category // "standard"' \
		"${CATALOG_FILE}" 2>/dev/null)
	EXPECTED_MODEL=$(jq -r --arg cat "${PREFERRED_CAT}" \
		'.categories[$cat].model // "sonnet"' \
		"${CATEGORIES_FILE}" 2>/dev/null)

	# Warn on model mismatch (advisory only — NOT blocking)
	if [[ "${SUBAGENT_MODEL}" != "default" ]] && [[ -n "${EXPECTED_MODEL}" ]] && [[ "${EXPECTED_MODEL}" != "${SUBAGENT_MODEL}" ]]; then
		ROUTING_CONTEXT+=" [ROUTING WARNING] Agent ${AGENT_NAME} prefers category '${PREFERRED_CAT}' (model=${EXPECTED_MODEL}), but spawned with model=${SUBAGENT_MODEL}."
	fi

	# Check concurrency limits
	ACTIVE_FILE="${STATE_DIR}/active-agents.json"
	if [[ -f "${ACTIVE_FILE}" ]]; then
		CURRENT_MODEL="${SUBAGENT_MODEL}"
		[[ "${CURRENT_MODEL}" == "default" ]] && CURRENT_MODEL="${EXPECTED_MODEL}"
		MODEL_COUNT=$(jq --arg m "${CURRENT_MODEL}" '[.[] | select(.model == $m)] | length' "${ACTIVE_FILE}" 2>/dev/null || echo 0)
		MODEL_LIMIT=$(jq -r --arg m "${CURRENT_MODEL}" '.concurrency_limits[$m] // 999' "${CATEGORIES_FILE}" 2>/dev/null)
		if [[ "${MODEL_COUNT}" -ge "${MODEL_LIMIT}" ]]; then
			ROUTING_CONTEXT+=" [CONCURRENCY WARNING] ${MODEL_COUNT}/${MODEL_LIMIT} ${CURRENT_MODEL} agents active."
		fi
	fi
fi

_HOOK_END=$(date +%s%N 2>/dev/null || date +%s)
_HOOK_MS=$(( (_HOOK_END - _HOOK_START) / 1000000 ))
echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"hook\":\"$(basename "$0")\",\"ms\":${_HOOK_MS}}" >> "${LOG_DIR}/hook-timing.jsonl" 2>/dev/null

SPAWN_MSG="Subagent ${SUBAGENT_TYPE} (${SPAWN_ID}) spawned with model ${SUBAGENT_MODEL}${ROUTING_CONTEXT}"
ESCAPED=$(printf '%s' "${SPAWN_MSG}" | jq -Rs .)
printf '%s\n' "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": ${ESCAPED}}}"
