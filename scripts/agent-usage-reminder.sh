#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

# Suppress reminders when agents are active. Union subagents.json (.active[].id,
# written on PreToolUse/Agent) with active-agents.json (.[].id, written on
# SubagentStart) — one file lags during the race; union covers both orderings.
ACTIVE_AGENTS="${STATE_DIR}/active-agents.json"
SUBAGENTS_FILE="${STATE_DIR}/subagents.json"
AGENT_COUNT=$(jq -rn \
	--argjson aa "$(jq -c '.' "${ACTIVE_AGENTS}" 2>/dev/null || echo '[]')" \
	--argjson sa "$(jq -c '.active // []' "${SUBAGENTS_FILE}" 2>/dev/null || echo '[]')" \
	'([$aa[].id] + [$sa[].id]) | unique | length')
if [[ "${AGENT_COUNT}" -gt 0 ]]; then
	exit 0  # Already delegating — don't nudge
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
COUNT=$(jq_read "${USAGE_FILE}" '.toolCallCount // 0')
COUNT="${COUNT:-0}"

if [[ $((COUNT % 3)) -eq 0 ]]; then
	MSG="[DELEGATION REMINDER] You've made ${COUNT} direct search/fetch calls without delegating.
Available agents: explore (codebase search), librarian (docs research), hephaestus (build fixes), momus (plan review), oracle (architecture advice).
Relevant skills: /refactor, /git-master, /playwright, /frontend-ui-ux.
Use Agent(subagent_type=\"oh-my-claudeagent:NAME\", prompt=\"...\") to delegate."
	emit_context "PostToolUse" "${MSG}"
else
	exit 0
fi
