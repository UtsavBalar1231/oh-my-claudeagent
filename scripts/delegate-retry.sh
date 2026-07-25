#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

ERROR_MSG=$(jq -r '.error // "Unknown error"' <<< "${HOOK_INPUT}")
SUBAGENT_TYPE=$(jq -r '.tool_input.subagent_type // "unknown"' <<< "${HOOK_INPUT}")
TOOL_NAME=$(jq -r '.tool_name // "Agent"' <<< "${HOOK_INPUT}")

if echo "${ERROR_MSG}" | grep -qi "No such tool available: Agent" || \
   echo "${ERROR_MSG}" | grep -qiE 'subagent.*nest|nest.*limit'; then
	MSG="[NESTING LIMIT] The Agent tool is unavailable — you are running as a subagent and cannot spawn further subagents. This is a Claude Code platform constraint. Implement the task directly using Read, Write, Edit, Bash, Grep, Glob. Do NOT retry Agent calls."
	emit_context "PostToolUseFailure" "${MSG}"
	exit 0
fi

# Spawn-budget ceilings are platform limits, not delegation mistakes: return before
# the error counter so a ceiling never counts toward the 3-strike oracle escalation.
if echo "${ERROR_MSG}" | grep -qiE 'concurrent subagent limit'; then
	MSG="[CONCURRENCY CEILING] Too many subagents are running at once (platform cap, default 20, raised via CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). Nothing about the prompt or the agent tier is wrong. Wait for in-flight agents to finish and read their results, then retry this spawn, or narrow the fan-out so fewer agents run at the same time. Do NOT retry immediately and do NOT escalate to oracle."
	emit_context "PostToolUseFailure" "${MSG}"
	exit 0
fi

if echo "${ERROR_MSG}" | grep -qiE 'subagent spawn limit|subagents per session'; then
	MSG="[SESSION SPAWN CEILING] This session has spawned its maximum number of subagents (platform cap, default 200, raised via CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION). Retrying the spawn cannot succeed. Complete the remaining work directly with Read, Write, Edit, Bash, Grep, Glob, or re-scope what is left and continue it in a fresh session. Do NOT escalate to oracle: this is an infrastructure ceiling, not an architectural problem."
	emit_context "PostToolUseFailure" "${MSG}"
	exit 0
fi

# 200 bytes — ERROR_MSG cap; enough to identify error class without flooding context.
ERROR_SUMMARY=$(echo "${ERROR_MSG}" | head -c 200)

ERROR_TEXT="${ERROR_MSG}"
if echo "${ERROR_TEXT}" | grep -qiE 'rate.limit|429|timeout|ECONNRESET|ETIMEDOUT'; then
	ERROR_CLASS="transient"
elif echo "${ERROR_TEXT}" | grep -qiE 'not.found|permission|EACCES|ENOENT|invalid.*schema'; then
	ERROR_CLASS="deterministic"
else
	ERROR_CLASS="unknown"
fi

ERROR_COUNTS_FILE="${STATE_DIR}/error-counts.json"
ERROR_KEY="${TOOL_NAME}:delegate_error"
NEW_COUNT=$(error_count_bump "${ERROR_KEY}" "${ERROR_MSG}")

RETRYABLE_PATTERNS="rate.limit|quota.exceeded|overloaded|too.many.requests|429|503|capacity|credit.balance|temporarily.unavailable|service.unavailable|timeout|ECONNRESET|ETIMEDOUT|rate_limit|resource_exhausted"

# 3 — circuit-breaker threshold: two failures are retriable (transient/capacity); third signals a stuck delegation loop.
CIRCUIT_BREAKER=""
if [[ "${NEW_COUNT}" -ge 3 ]]; then
	TIMELINE=$(jq -r --arg key "${ERROR_KEY}" \
		'(.[$key].last_errors // []) | reverse | to_entries | map("\(.key + 1)) \(.value)") | join(" ")' \
		"${ERROR_COUNTS_FILE}" 2>/dev/null)
	CIRCUIT_BREAKER=" This error has occurred 3+ times. Attempts: ${TIMELINE}. Stop retrying the same approach. Escalate to oracle for architectural guidance or try a fundamentally different approach."
fi

if echo "${ERROR_MSG}" | grep -qiE "${RETRYABLE_PATTERNS}"; then
	TRANSIENT_NOTE="This is a tool/infrastructure failure, not a reasoning error. Do not self-reflect on your approach: the tool itself failed. Either resume after a moment or escalate."
	MSG="[ERROR RECOVERY] Type: transient | Tool: ${TOOL_NAME} | Retry: ${NEW_COUNT}/3
[RETRYABLE ERROR] The delegation failed due to a transient error (rate limit, capacity, timeout). The failure carries whatever the agent produced before it was cut off: read that partial work, then delegate only the remainder instead of re-sending the original prompt. Do not escalate to oracle for transient failures. ${TRANSIENT_NOTE}${CIRCUIT_BREAKER}"
	emit_context "PostToolUseFailure" "${MSG}"
	exit 0
fi

MSG="[ERROR RECOVERY] Type: ${ERROR_CLASS} | Tool: ${TOOL_NAME} | Retry: ${NEW_COUNT}/3
[DELEGATE RETRY] Task delegation failed for agent '${SUBAGENT_TYPE}': ${ERROR_SUMMARY}. Consider: 1) Retry with more specific prompt, 2) Try a different agent tier, 3) Break task into smaller pieces.${CIRCUIT_BREAKER}"
emit_context "PostToolUseFailure" "${MSG}"
