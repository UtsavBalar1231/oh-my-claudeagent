#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

ERROR_MSG=$(jq -r '.error // .tool_result.error // .output // "Unknown error"' <<< "${HOOK_INPUT}")
SUBAGENT_TYPE=$(jq -r '.tool_input.subagent_type // "unknown"' <<< "${HOOK_INPUT}")
TOOL_NAME=$(jq -r '.tool_name // "Agent"' <<< "${HOOK_INPUT}")

if echo "${ERROR_MSG}" | grep -qi "No such tool available: Agent"; then
	MSG="[NESTING LIMIT] The Agent tool is unavailable — you are running as a subagent and cannot spawn further subagents. This is a Claude Code platform constraint. Implement the task directly using Read, Write, Edit, Bash, Grep, Glob. Do NOT retry Agent calls."
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

if [[ -f "${ERROR_COUNTS_FILE}" ]]; then
	CURRENT_COUNT=$(jq -r --arg key "${ERROR_KEY}" '.[$key] // 0' "${ERROR_COUNTS_FILE}")
else
	CURRENT_COUNT=0
fi

NEW_COUNT=$((CURRENT_COUNT + 1))

TMP_COUNTS=$(mktemp)
if [[ -f "${ERROR_COUNTS_FILE}" ]]; then
	jq --arg key "${ERROR_KEY}" --argjson count "${NEW_COUNT}" '.[$key] = $count' "${ERROR_COUNTS_FILE}" >"${TMP_COUNTS}" 2>/dev/null || echo "{\"${ERROR_KEY}\": ${NEW_COUNT}}" >"${TMP_COUNTS}"
else
	echo "{\"${ERROR_KEY}\": ${NEW_COUNT}}" >"${TMP_COUNTS}"
fi
mv "${TMP_COUNTS}" "${ERROR_COUNTS_FILE}"

RETRYABLE_PATTERNS="rate.limit|quota.exceeded|overloaded|too.many.requests|429|503|capacity|credit.balance|temporarily.unavailable|service.unavailable|timeout|ECONNRESET|ETIMEDOUT|rate_limit|resource_exhausted"

CIRCUIT_BREAKER=""
if [[ "${NEW_COUNT}" -ge 3 ]]; then
	CIRCUIT_BREAKER=" This error has occurred 3+ times. Stop retrying the same approach. Escalate to oracle for architectural guidance or try a fundamentally different approach."
fi

if echo "${ERROR_MSG}" | grep -qiE "${RETRYABLE_PATTERNS}"; then
	TRANSIENT_NOTE="This is a tool/infrastructure failure, not a reasoning error. Do not self-reflect on your approach — the tool itself failed. Either retry after a moment or escalate."
	MSG="[ERROR RECOVERY] Type: transient | Tool: ${TOOL_NAME} | Retry: ${NEW_COUNT}/3
[RETRYABLE ERROR] The delegation failed due to a transient error (rate limit, capacity, timeout). Retry the same delegation — do not escalate to oracle for transient failures. ${TRANSIENT_NOTE}${CIRCUIT_BREAKER}"
	emit_context "PostToolUseFailure" "${MSG}"
	exit 0
fi

MSG="[ERROR RECOVERY] Type: ${ERROR_CLASS} | Tool: ${TOOL_NAME} | Retry: ${NEW_COUNT}/3
[DELEGATE RETRY] Task delegation failed for agent '${SUBAGENT_TYPE}': ${ERROR_SUMMARY}. Consider: 1) Retry with more specific prompt, 2) Try a different agent tier, 3) Break task into smaller pieces.${CIRCUIT_BREAKER}"
emit_context "PostToolUseFailure" "${MSG}"
