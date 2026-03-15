#!/bin/bash

INPUT=$(cat)

TOOL_NAME=$(echo "${INPUT}" | jq -r '.tool_name // ""' 2>/dev/null)
ERROR_MSG=$(echo "${INPUT}" | jq -r '.error // .tool_result.error // ""' 2>/dev/null)

case "${TOOL_NAME}" in
Bash | Read | Grep | Glob | WebFetch | WebSearch)
	exit 0
	;;
*)
	;;
esac

if echo "${ERROR_MSG}" | grep -qiE '(invalid JSON|malformed JSON|parse error|SyntaxError|Unexpected token|JSON\.parse)'; then
	MSG="[JSON ERROR RECOVERY] JSON parse error detected in ${TOOL_NAME}. Common fixes: 1) Check for trailing commas in objects/arrays, 2) Ensure all strings are double-quoted, 3) Escape special characters in string values, 4) Verify brackets/braces are balanced. Error: $(echo "${ERROR_MSG}" | head -c 200)"
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUseFailure\", \"additionalContext\": ${ESCAPED}}}"
else
	exit 0
fi
