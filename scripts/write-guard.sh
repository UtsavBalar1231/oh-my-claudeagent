#!/bin/bash

INPUT=$(cat)

FILE_PATH=$(echo "${INPUT}" | jq -r '.tool_input.file_path // ""' 2>/dev/null)

if [[ -z "${FILE_PATH}" ]]; then
	exit 0
fi

# Intercept manual writes to verification-evidence.json
case "${FILE_PATH}" in
	*/verification-evidence.json)
		MSG="[EVIDENCE GUARD] Do NOT manually write verification-evidence.json. Use the evidence_record MCP tool instead. Example: evidence_record(type=\"test\", command=\"just test\", exit_code=0, output_snippet=\"10 passed\")"
		ESCAPED=$(echo "${MSG}" | jq -Rs .)
		echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": ${ESCAPED}}}"
		exit 0
		;;
	*) ;;
esac

if [[ -f "${FILE_PATH}" ]]; then
	MSG="[WRITE GUARD] File already exists: ${FILE_PATH}. Consider using Edit tool for modifications to preserve existing content."
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": ${ESCAPED}}}"
else
	exit 0
fi
