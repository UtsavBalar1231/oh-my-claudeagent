#!/bin/bash

INPUT=$(cat)

FILE_PATH=$(echo "${INPUT}" | jq -r '.tool_input.file_path // ""' 2>/dev/null)

if [[ -z "${FILE_PATH}" ]]; then
	exit 0
fi

if [[ -f "${FILE_PATH}" ]]; then
	MSG="[WRITE GUARD] File already exists: ${FILE_PATH}. Consider using Edit tool for modifications to preserve existing content."
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"allow\", \"additionalContext\": ${ESCAPED}}}"
else
	exit 0
fi
