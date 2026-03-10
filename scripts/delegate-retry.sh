#!/bin/bash

INPUT=$(cat)

ERROR_MSG=$(echo "${INPUT}" | jq -r '.error // .tool_result.error // "Unknown error"' 2>/dev/null)
SUBAGENT_TYPE=$(echo "${INPUT}" | jq -r '.tool_input.subagent_type // "unknown"' 2>/dev/null)

ERROR_SUMMARY=$(echo "${ERROR_MSG}" | head -c 200)

MSG="[DELEGATE RETRY] Task delegation failed for agent '${SUBAGENT_TYPE}': ${ERROR_SUMMARY}. Consider: 1) Retry with more specific prompt, 2) Try a different agent tier, 3) Break task into smaller pieces."
ESCAPED=$(echo "${MSG}" | jq -Rs .)

echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUseFailure\", \"additionalContext\": ${ESCAPED}}}"
