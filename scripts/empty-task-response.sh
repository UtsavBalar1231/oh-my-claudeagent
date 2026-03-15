#!/bin/bash

INPUT=$(cat)

RESPONSE=$(echo "${INPUT}" | jq -r '.tool_response // .tool_result // ""' 2>/dev/null)

RESPONSE_LENGTH=${#RESPONSE}

if [[ "${RESPONSE_LENGTH}" -lt 10 ]] || [[ -z "$(echo "${RESPONSE}" | tr -d '[:space:]' || true)" ]]; then
	MSG="[EMPTY TASK RESPONSE] The delegated task returned an empty or trivially short response. The agent may have failed silently, hit a context limit, or had no useful output. Consider: 1) Retry with a more specific prompt, 2) Check if the agent had the right tools, 3) Break the task into smaller pieces."
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": ${ESCAPED}}}"
else
	PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
	USAGE_FILE="${PROJECT_ROOT}/.omca/state/agent-usage.json"
	if [[ -f "${USAGE_FILE}" ]]; then
		TMP=$(mktemp)
		jq '.agentUsed = true' "${USAGE_FILE}" >"${TMP}" && mv "${TMP}" "${USAGE_FILE}"
	fi
	exit 0
fi
