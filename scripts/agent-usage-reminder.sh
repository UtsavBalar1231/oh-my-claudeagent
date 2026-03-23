#!/bin/bash

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
mkdir -p "${STATE_DIR}"

# Suppress delegation reminders during active agent delegations
ACTIVE_AGENTS="${STATE_DIR}/active-agents.json"
if [[ -f "${ACTIVE_AGENTS}" ]]; then
	AGENT_COUNT=$(jq 'length' "${ACTIVE_AGENTS}" 2>/dev/null || echo 0)
	if [[ "${AGENT_COUNT}" -gt 0 ]]; then
		exit 0  # Already delegating — don't nudge
	fi
fi

USAGE_FILE="${STATE_DIR}/agent-usage.json"
if [[ ! -f "${USAGE_FILE}" ]]; then
	echo '{"agentUsed": false, "toolCallCount": 0}' >"${USAGE_FILE}"
fi

AGENT_USED=$(jq -r '.agentUsed // false' "${USAGE_FILE}" 2>/dev/null)

if [[ "${AGENT_USED}" == "true" ]]; then
	exit 0
fi

TMP=$(mktemp)
jq '.toolCallCount += 1' "${USAGE_FILE}" >"${TMP}" && mv "${TMP}" "${USAGE_FILE}"
COUNT=$(jq -r '.toolCallCount' "${USAGE_FILE}" 2>/dev/null)

# Nudge every 3rd direct tool call
if [[ $((COUNT % 3)) -eq 0 ]]; then
	MSG="[DELEGATION REMINDER] You've made ${COUNT} direct search/fetch calls without delegating.
Available agents: explore (codebase search), librarian (docs research), hephaestus (build fixes), momus (plan review), oracle (architecture advice).
Relevant skills: /refactor, /git-master, /playwright, /frontend-ui-ux.
Use Agent(subagent_type=\"oh-my-claudeagent:NAME\", prompt=\"...\") to delegate."
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": ${ESCAPED}}}"
else
	exit 0
fi
