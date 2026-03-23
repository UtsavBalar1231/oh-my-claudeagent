#!/bin/bash

INPUT=$(cat)

ERROR_MSG=$(echo "${INPUT}" | jq -r '.error // .tool_result.error // .output // "Unknown error"' 2>/dev/null)
SUBAGENT_TYPE=$(echo "${INPUT}" | jq -r '.tool_input.subagent_type // "unknown"' 2>/dev/null)
TOOL_NAME=$(echo "${INPUT}" | jq -r '.tool_name // "Task"' 2>/dev/null)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"

mkdir -p "${STATE_DIR}"

# Detect subagent nesting depth violation (non-recoverable)
# Error string observed in atlas transcript (agent-a6ece1cf5c29f1da5.jsonl)
# grep -qi provides case-insensitive matching for resilience against format changes
if echo "${ERROR_MSG}" | grep -qi "No such tool available: Agent"; then
	MSG="[NESTING LIMIT] The Agent tool is unavailable — you are running as a subagent and cannot spawn further subagents. This is a Claude Code platform constraint. Implement the task directly using Read, Write, Edit, Bash, Grep, Glob. Do NOT retry Agent calls."
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUseFailure\", \"additionalContext\": ${ESCAPED}}}"
	exit 0
fi

ERROR_SUMMARY=$(echo "${ERROR_MSG}" | head -c 200)

# Task 2.2 — Error classification
ERROR_TEXT="${ERROR_MSG}"
if echo "${ERROR_TEXT}" | grep -qiE 'rate.limit|429|timeout|ECONNRESET|ETIMEDOUT'; then
	ERROR_CLASS="transient"
elif echo "${ERROR_TEXT}" | grep -qiE 'not.found|permission|EACCES|ENOENT|invalid.*schema'; then
	ERROR_CLASS="deterministic"
else
	ERROR_CLASS="unknown"
fi

# Task 2.1 — Retry count tracking
ERROR_COUNTS_FILE="${STATE_DIR}/error-counts.json"
ERROR_KEY="${TOOL_NAME}:delegate_error"

if [[ -f "${ERROR_COUNTS_FILE}" ]]; then
	CURRENT_COUNT=$(jq -r --arg key "${ERROR_KEY}" '.[$key] // 0' "${ERROR_COUNTS_FILE}" 2>/dev/null || echo "0")
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

# Check for retryable error patterns (keep original RETRYABLE_PATTERNS logic)
RETRYABLE_PATTERNS="rate.limit|quota.exceeded|overloaded|too.many.requests|429|503|capacity|credit.balance|temporarily.unavailable|service.unavailable|timeout|ECONNRESET|ETIMEDOUT|rate_limit|resource_exhausted"

# Circuit-breaker at 3+ retries
CIRCUIT_BREAKER=""
if [[ "${NEW_COUNT}" -ge 3 ]]; then
	CIRCUIT_BREAKER=" This error has occurred 3+ times. Stop retrying the same approach. Escalate to oracle for architectural guidance or try a fundamentally different approach."
fi

if echo "${ERROR_MSG}" | grep -qiE "${RETRYABLE_PATTERNS}"; then
	# Task 2.4 — Stagnation-aware reflection suppression for transient errors
	TRANSIENT_NOTE="This is a tool/infrastructure failure, not a reasoning error. Do not self-reflect on your approach — the tool itself failed. Either retry after a moment or escalate."
	# Task 2.3 — Structured output
	MSG="[ERROR RECOVERY] Type: transient | Tool: ${TOOL_NAME} | Retry: ${NEW_COUNT}/3
[RETRYABLE ERROR] The delegation failed due to a transient error (rate limit, capacity, timeout). Retry the same delegation — do not escalate to oracle for transient failures. ${TRANSIENT_NOTE}${CIRCUIT_BREAKER}"
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUseFailure\", \"additionalContext\": ${ESCAPED}}}"
	exit 0
fi

# Task 2.3 — Structured output for non-retryable delegate errors
# Task 2.4 — For deterministic/unknown: do NOT suppress reflection
MSG="[ERROR RECOVERY] Type: ${ERROR_CLASS} | Tool: ${TOOL_NAME} | Retry: ${NEW_COUNT}/3
[DELEGATE RETRY] Task delegation failed for agent '${SUBAGENT_TYPE}': ${ERROR_SUMMARY}. Consider: 1) Retry with more specific prompt, 2) Try a different agent tier, 3) Break task into smaller pieces.${CIRCUIT_BREAKER}"
ESCAPED=$(echo "${MSG}" | jq -Rs .)

echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUseFailure\", \"additionalContext\": ${ESCAPED}}}"
