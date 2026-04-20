#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

FILE_PATH=$(jq -r '.tool_input.file_path // "unknown"' <<< "${HOOK_INPUT}")
ERROR_MSG=$(jq -r '.error // .tool_result.error // "Unknown error"' <<< "${HOOK_INPUT}")
TOOL_NAME=$(jq -r '.tool_name // "Edit"' <<< "${HOOK_INPUT}")

TIMESTAMP=$(date -Iseconds)

# Unified error log (errors.jsonl)
LOG_FILE="${LOG_DIR}/errors.jsonl"
jq -nc --arg file "${FILE_PATH}" --arg err "${ERROR_MSG}" --arg ts "${TIMESTAMP}" \
	'{event: "edit_error", file: $file, error: $err, timestamp: $ts}' >>"${LOG_FILE}"

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
ERROR_KEY="${TOOL_NAME}:edit_error"

if [[ -f "${ERROR_COUNTS_FILE}" ]]; then
	CURRENT_COUNT=$(jq -r --arg key "${ERROR_KEY}" '.[$key] // 0' "${ERROR_COUNTS_FILE}")
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

# Task 2.3 — Recovery guidance based on error patterns
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

# Circuit-breaker at 3+ retries
CIRCUIT_BREAKER=""
if [[ "${NEW_COUNT}" -ge 3 ]]; then
	CIRCUIT_BREAKER=" This error has occurred 3+ times. Stop retrying the same approach. Escalate to oracle for architectural guidance or try a fundamentally different approach."
fi

# Task 2.3 — Structured output format
MSG="[ERROR RECOVERY] Type: ${ERROR_CLASS} | Tool: ${TOOL_NAME} | Retry: ${NEW_COUNT}/3
${RECOVERY_SUGGESTION}${CIRCUIT_BREAKER}"

emit_context "PostToolUseFailure" "${MSG}"
