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

MSG="[DELEGATE RETRY] Task delegation failed for agent '${SUBAGENT_TYPE}': ${ERROR_SUMMARY}. Consider: 1) Retry with more specific prompt, 2) Try a different agent tier, 3) Break task into smaller pieces."
ESCAPED=$(echo "${MSG}" | jq -Rs .)

echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUseFailure\", \"additionalContext\": ${ESCAPED}}}"
