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

AGENT_TYPE=$(echo "${INPUT}" | jq -r '.agent_type // "unknown"')

case "${AGENT_TYPE}" in
	*prometheus*|*metis*|*socrates*)
		CONTEXT_PARTS="AskUserQuestion is unavailable in subagents. When you need user input, write the question to the notepad questions section and return. The orchestrator will relay to the user and resume you."
		;;
	*sisyphus|*atlas*)
		CONTEXT_PARTS="AskUserQuestion is unavailable in subagents. When you need user input, write the question to the notepad questions section and return. The orchestrator will relay to the user and resume you."
		;;
	*explore*|*librarian*|*hephaestus*|*sisyphus-junior*|*multimodal*|*oracle*|*momus*)
		CONTEXT_PARTS="AskUserQuestion is unavailable in subagents. Make autonomous decisions when possible. If genuinely blocked, write the question to the notepad questions section and return."
		;;
	*)
		CONTEXT_PARTS="Make autonomous decisions. If unclear, choose the most reasonable option and proceed."
		;;
esac

for MODE_FILE in ralph-state.json ultrawork-state.json autopilot-state.json team-state.json; do
	if [[ -f "${STATE_DIR}/${MODE_FILE}" ]]; then
		MODE_STATUS=$(jq -r '.status // "inactive"' "${STATE_DIR}/${MODE_FILE}" 2>/dev/null)
		if [[ "${MODE_STATUS}" == "active" ]]; then
			MODE_NAME="${MODE_FILE%-state.json}"
			CONTEXT_PARTS+=" [${MODE_NAME^^} MODE ACTIVE] Continue working in ${MODE_NAME} mode."
		fi
	fi
done

BOULDER_FILE="${STATE_DIR}/boulder.json"
if [[ -f "${BOULDER_FILE}" ]]; then
	PLAN_FILE=$(jq -r '.active_plan // empty' "${BOULDER_FILE}" 2>/dev/null || echo "")
	PLAN_NAME=$(jq -r '.plan_name // empty' "${BOULDER_FILE}" 2>/dev/null || echo "")
	if [[ -n "${PLAN_FILE}" ]]; then
		CONTEXT_PARTS+=" [ACTIVE PLAN] Refer to: ${PLAN_FILE}"
		CONTEXT_PARTS+=" CRITICAL: The plan file at ${PLAN_FILE} is READ-ONLY. NEVER modify the plan file directly. Use omca_notepad_write to record issues or decisions instead."
	fi
	if [[ -n "${PLAN_NAME}" ]]; then
		CONTEXT_PARTS+=" [NOTEPAD AVAILABLE] Plan: ${PLAN_NAME}. Use omca_notepad_write('${PLAN_NAME}', section, content) to record discoveries. Sections: learnings, issues, decisions, problems, questions. Use 'questions' when you need user input (AskUserQuestion is unavailable in subagents). Always APPEND — never overwrite."
	fi
fi

ESCAPED=$(printf '%s' "${CONTEXT_PARTS}" | jq -Rs .)
printf '%s\n' "{\"hookSpecificOutput\": {\"hookEventName\": \"SubagentStart\", \"additionalContext\": ${ESCAPED}}}"
