#!/bin/bash

INPUT=$(cat)

FILE_PATH=$(echo "${INPUT}" | jq -r '.tool_input.file_path // "unknown"' 2>/dev/null)
ERROR_MSG=$(echo "${INPUT}" | jq -r '.error // .tool_result.error // "Unknown error"' 2>/dev/null)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"

mkdir -p "${LOG_DIR}"

TIMESTAMP=$(date -Iseconds)

LOG_FILE="${LOG_DIR}/errors.jsonl"
jq -nc --arg file "${FILE_PATH}" --arg err "${ERROR_MSG}" --arg ts "${TIMESTAMP}" \
	'{event: "edit_error", file: $file, error: $err, timestamp: $ts}' >>"${LOG_FILE}"

RECOVERY_SUGGESTION=""

if echo "${ERROR_MSG}" | grep -qi "not unique"; then
	RECOVERY_SUGGESTION="The old_string is not unique in the file. Include more surrounding context to make it unique, or use replace_all if you want to replace all occurrences."
elif echo "${ERROR_MSG}" | grep -qi "not found"; then
	RECOVERY_SUGGESTION="The old_string was not found in the file. The file may have changed. Re-read the file to get current contents before editing."
elif echo "${ERROR_MSG}" | grep -qi "permission"; then
	RECOVERY_SUGGESTION="Permission denied. Check file permissions or if the file is locked by another process."
elif echo "${ERROR_MSG}" | grep -qi "no such file"; then
	RECOVERY_SUGGESTION="File does not exist. Use Write tool to create it, or check the file path is correct."
else
	RECOVERY_SUGGESTION="Edit failed. Re-read the file to verify current contents match your old_string exactly, including whitespace and indentation."
fi

ESCAPED=$(echo "[EDIT ERROR RECOVERY] ${RECOVERY_SUGGESTION}" | jq -Rs .)
echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUseFailure\", \"additionalContext\": ${ESCAPED}}}"
