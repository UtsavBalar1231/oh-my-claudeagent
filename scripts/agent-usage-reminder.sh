#!/bin/bash

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
mkdir -p "${STATE_DIR}"

USAGE_FILE="${STATE_DIR}/agent-usage.json"
if [[ ! -f "${USAGE_FILE}" ]]; then
	echo '{"agentUsed": false, "toolCallCount": 0}' >"${USAGE_FILE}"
fi

AGENT_USED=$(jq -r '.agentUsed // false' "${USAGE_FILE}" 2>/dev/null)

if [[ "${AGENT_USED}" == "true" ]]; then
	exit 0
fi

TMP=$(mktemp)
jq '.toolCallCount += 1 | if .toolCallCount >= 3 then .toolCallCount = 0 else . end' "${USAGE_FILE}" >"${TMP}" && mv "${TMP}" "${USAGE_FILE}"
RESULT=$(jq -r '.toolCallCount' "${USAGE_FILE}" 2>/dev/null)
if [[ "${RESULT}" == "0" ]]; then
	RESULT="3"
else
	RESULT="below"
fi

if [[ "${RESULT}" != "below" ]]; then
	MSG="[DELEGATION REMINDER] You've made ${RESULT} direct search/fetch calls without delegating to an agent. Consider using Task tool with explore, librarian, or other specialized agents for better results and to follow the delegation-first philosophy."
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": ${ESCAPED}}}"
else
	exit 0
fi
