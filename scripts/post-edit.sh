#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

FILE_PATH=$(jq -r '.tool_input.file_path // .tool_input.path // "unknown"' <<< "${HOOK_INPUT}")
TOOL_NAME=$(jq -r '.tool_name // "unknown"' <<< "${HOOK_INPUT}")
TOOL_RESULT=$(jq -r '.tool_result.success // true' <<< "${HOOK_INPUT}")

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
