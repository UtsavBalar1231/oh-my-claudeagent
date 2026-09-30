#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

ERROR_MSG=$(jq -r '.error // "Unknown error"' <<< "${HOOK_INPUT}")
SUBAGENT_TYPE=$(jq -r '.tool_input.subagent_type // "unknown"' <<< "${HOOK_INPUT}")
TOOL_NAME=$(jq -r '.tool_name // "Agent"' <<< "${HOOK_INPUT}")

if echo "${ERROR_MSG}" | grep -qi "No such tool available: Agent" || \
   echo "${ERROR_MSG}" | grep -qiE 'subagent.*nest|nest.*limit'; then
	MSG="[NESTING LIMIT] The Agent tool is not in this agent's tool list: its definition disallows it, a session restriction removed it, or it is at the subagent depth limit (CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, three layers below the main conversation by default). Every Agent call fails the same way, so do the work directly with the tools you have."
	emit_context "PostToolUseFailure" "${MSG}"
	exit 0
fi

# A concurrency ceiling is a platform limit, not a delegation mistake: return before
# the error counter so a ceiling never counts toward the 3-strike oracle escalation.
if echo "${ERROR_MSG}" | grep -qiE 'concurrent subagent limit'; then
	MSG="[CONCURRENCY CEILING] Too many subagents are running at once (platform cap, default 20, raised via CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). Nothing about the prompt or the agent tier is wrong. Wait for in-flight agents to finish and read their results, then retry this spawn, or narrow the fan-out so fewer agents run at the same time. Do NOT retry immediately and do NOT escalate to oracle."
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
	CIRCUIT_BREAKER=" This tool has failed 3+ times, each failure within five minutes of the last. Attempts: ${TIMELINE}. The count covers every failure of the tool, related or not. If these are repeated attempts at one fix, stop repeating it: change the approach, or ask for a diagnosis, from the advisor tool when you have it and from oracle when you do not."
fi

if echo "${ERROR_MSG}" | grep -qiE "${RETRYABLE_PATTERNS}"; then
	TRANSIENT_NOTE="The failure is in the service, not in your prompt or approach. Once it clears, resume the same agent with SendMessage so it keeps its history, or delegate only the remainder."
	MSG="[ERROR RECOVERY] Type: transient | Tool: ${TOOL_NAME} | Retry: ${NEW_COUNT}/3
[RETRYABLE ERROR] The delegation failed due to a transient error (rate limit, capacity, timeout). Claude Code already exhausted its own recovery before this surfaced: a response cut off mid-stream is continued automatically, and a model-level failure is routed through the fallback model chain when one is configured. The failure carries whatever the agent produced before it was cut off: read that partial work, then delegate only the remainder instead of re-sending the original prompt. Do not escalate to oracle for transient failures. ${TRANSIENT_NOTE}${CIRCUIT_BREAKER}"
	emit_context "PostToolUseFailure" "${MSG}"
	exit 0
fi

MSG="[ERROR RECOVERY] Type: ${ERROR_CLASS} | Tool: ${TOOL_NAME} | Retry: ${NEW_COUNT}/3
[DELEGATE RETRY] Task delegation failed for agent '${SUBAGENT_TYPE}': ${ERROR_SUMMARY}. A mid-stream cutoff and a model-level failure are handled by the platform on their own (automatic continuation, and the fallback model chain when one is configured), so treat this as a real tool failure. Consider: 1) Retry with a more specific prompt, 2) Break the task into smaller pieces.${CIRCUIT_BREAKER}"
emit_context "PostToolUseFailure" "${MSG}"
