#!/bin/bash

INPUT=$(cat)

ERROR_MSG=$(echo "${INPUT}" | jq -r '.error // .tool_result.error // "Unknown error"' 2>/dev/null)
SUBAGENT_TYPE=$(echo "${INPUT}" | jq -r '.tool_input.subagent_type // "unknown"' 2>/dev/null)

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

# Check for retryable error patterns
RETRYABLE_PATTERNS="rate.limit|quota.exceeded|overloaded|too.many.requests|429|503|capacity|credit.balance|temporarily.unavailable|service.unavailable|timeout|ECONNRESET|ETIMEDOUT|rate_limit|resource_exhausted"

ERROR_TEXT=$(echo "${INPUT}" | jq -r '.error // .tool_result.error // .output // ""' 2>/dev/null)
if echo "${ERROR_TEXT}" | grep -qiE "${RETRYABLE_PATTERNS}"; then
	# Retryable error — suggest retry, not escalation
	cat <<RETRYEOF
{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"[RETRYABLE ERROR] The delegation failed due to a transient error (rate limit, capacity, timeout). Retry the same delegation — do not escalate to oracle for transient failures."}}
RETRYEOF
	exit 0
fi

MSG="[DELEGATE RETRY] Task delegation failed for agent '${SUBAGENT_TYPE}': ${ERROR_SUMMARY}. Consider: 1) Retry with more specific prompt, 2) Try a different agent tier, 3) Break task into smaller pieces."
ESCAPED=$(echo "${MSG}" | jq -Rs .)

echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUseFailure\", \"additionalContext\": ${ESCAPED}}}"
