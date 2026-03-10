#!/bin/bash

INPUT=$(cat)
AGENT_ID=$(echo "${INPUT}" | jq -r '.agent_id // "unknown"')
TIMESTAMP=$(date -Iseconds)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"
mkdir -p "${STATE_DIR}" "${LOG_DIR}"

LOG_FILE="${LOG_DIR}/agent-spawns.log"
echo "${TIMESTAMP} - Agent spawned: ${AGENT_ID}" >>"${LOG_FILE}"

TEAM_STATE="${STATE_DIR}/team-state.json"
if [[ -f "${TEAM_STATE}" ]]; then
	STATUS=$(jq -r '.status // "inactive"' "${TEAM_STATE}")
	if [[ "${STATUS}" == "active" ]]; then
		TMP=$(mktemp)
		jq --arg aid "${AGENT_ID}" '.agents += [$aid]' "${TEAM_STATE}" >"${TMP}" && mv "${TMP}" "${TEAM_STATE}"
	fi
fi

CONTEXT_PARTS="Make autonomous decisions. Never ask questions — if unclear, choose the most reasonable option and proceed."

for MODE_FILE in ralph-state.json ultrawork-state.json autopilot-state.json team-state.json; do
	if [[ -f "${STATE_DIR}/${MODE_FILE}" ]]; then
		MODE_STATUS=$(jq -r '.status // "inactive"' "${STATE_DIR}/${MODE_FILE}" 2>/dev/null)
		if [[ "${MODE_STATUS}" == "active" ]]; then
			MODE_NAME="${MODE_FILE%-state.json}"
			CONTEXT_PARTS+=" [${MODE_NAME^^} MODE ACTIVE] Continue working in ${MODE_NAME} mode."
		fi
	fi
done

MEMORY_FILE="${PROJECT_ROOT}/.omca/project-memory.json"
if [[ -f "${MEMORY_FILE}" ]]; then
	CONVENTIONS=$(jq -r '.conventions // empty | to_entries | map("\(.key): \(.value)") | join(". ")' "${MEMORY_FILE}" 2>/dev/null || echo "")
	if [[ -n "${CONVENTIONS}" ]]; then
		CONTEXT_PARTS+=" [PROJECT CONVENTIONS] ${CONVENTIONS}"
	fi
fi

BOULDER_FILE="${STATE_DIR}/boulder.json"
if [[ -f "${BOULDER_FILE}" ]]; then
	PLAN_FILE=$(jq -r '.planFile // empty' "${BOULDER_FILE}" 2>/dev/null || echo "")
	if [[ -n "${PLAN_FILE}" ]]; then
		CONTEXT_PARTS+=" [ACTIVE PLAN] Refer to: ${PLAN_FILE}"
	fi
fi

ESCAPED=$(printf '%s' "${CONTEXT_PARTS}" | jq -Rs .)
printf '%s\n' "{\"hookSpecificOutput\": {\"hookEventName\": \"SubagentStart\", \"additionalContext\": ${ESCAPED}}}"
