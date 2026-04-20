#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

# Suppress delegation reminders during active agent delegations
ACTIVE_AGENTS="${STATE_DIR}/active-agents.json"
if [[ -f "${ACTIVE_AGENTS}" ]]; then
	AGENT_COUNT=$(jq 'length' "${ACTIVE_AGENTS}")
	if [[ "${AGENT_COUNT}" -gt 0 ]]; then
		exit 0  # Already delegating — don't nudge
	fi
fi

USAGE_FILE="${STATE_DIR}/agent-usage.json"
if [[ ! -f "${USAGE_FILE}" ]]; then
	echo '{"agentUsed": false, "toolCallCount": 0}' >"${USAGE_FILE}"
fi

AGENT_USED=$(jq_read "${USAGE_FILE}" '.agentUsed // false')

if [[ "${AGENT_USED}" == "true" ]]; then
	exit 0
fi

TMP=$(mktemp)
jq '.toolCallCount += 1' "${USAGE_FILE}" >"${TMP}" && mv "${TMP}" "${USAGE_FILE}"
COUNT=$(jq -r '.toolCallCount' "${USAGE_FILE}" 2>/dev/null)

if [[ $((COUNT % 3)) -eq 0 ]]; then
	MSG="[DELEGATION REMINDER] You've made ${COUNT} direct search/fetch calls without delegating.
Available agents: explore (codebase search), librarian (docs research), hephaestus (build fixes), momus (plan review), oracle (architecture advice).
Relevant skills: /refactor, /git-master, /playwright, /frontend-ui-ux.
Use Agent(subagent_type=\"oh-my-claudeagent:NAME\", prompt=\"...\") to delegate."
	emit_context "PostToolUse" "${MSG}"
else
	exit 0
fi
