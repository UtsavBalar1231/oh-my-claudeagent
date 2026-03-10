#!/bin/bash

INPUT=$(cat)

FILE_PATH=$(echo "${INPUT}" | jq -r '.tool_input.file_path // .tool_input.path // "unknown"' 2>/dev/null)
TOOL_NAME=$(echo "${INPUT}" | jq -r '.tool_name // "unknown"' 2>/dev/null)
TOOL_RESULT=$(echo "${INPUT}" | jq -r '.tool_result.success // true' 2>/dev/null)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"

mkdir -p "${STATE_DIR}" "${LOG_DIR}"

TIMESTAMP=$(date -Iseconds)

LOG_FILE="${LOG_DIR}/edits.jsonl"
jq -nc --arg tool "${TOOL_NAME}" --arg file "${FILE_PATH}" --argjson ok "${TOOL_RESULT}" --arg ts "${TIMESTAMP}" \
	'{event: "file_edit", tool: $tool, file: $file, success: $ok, timestamp: $ts}' >>"${LOG_FILE}"

EDITS_FILE="${STATE_DIR}/recent-edits.json"
if [[ ! -f "${EDITS_FILE}" ]]; then
	echo '{"files":{}}' >"${EDITS_FILE}"
fi

TMP_FILE=$(mktemp)
jq --arg file "${FILE_PATH}" --arg ts "${TIMESTAMP}" \
	'.files[$file] = $ts' \
	"${EDITS_FILE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${EDITS_FILE}"

exit 0
