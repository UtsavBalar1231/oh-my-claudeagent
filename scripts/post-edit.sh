#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

FILE_PATH=$(jq -r '.tool_input.file_path // .tool_input.path // "unknown"' <<< "${HOOK_INPUT}")
TOOL_NAME=$(jq -r '.tool_name // "unknown"' <<< "${HOOK_INPUT}")
# Canonical PostToolUse field is `.tool_response` (not `.tool_result`).
# `//` is falsy-sensitive (fires on `false` AND `null`), so a plain `// true` fallback
# would silently convert `false` to `true`. Null-check form preserves real `false`.
TOOL_RESULT=$(jq -r 'if .tool_response.success == null then true else .tool_response.success end' <<< "${HOOK_INPUT}")

TIMESTAMP=$(date -Iseconds)

LOG_FILE="${LOG_DIR}/edits.jsonl"
jq -nc --arg tool "${TOOL_NAME}" --arg file "${FILE_PATH}" --argjson ok "${TOOL_RESULT}" --arg ts "${TIMESTAMP}" \
	'{event: "file_edit", tool: $tool, file: $file, success: $ok, timestamp: $ts}' >>"${LOG_FILE}"

EDITS_FILE="${STATE_DIR}/recent-edits.json"

# flock-protected read-modify-write to prevent concurrent Write races
(
	# 5s — flock wait; long enough for concurrent siblings, short enough to fail fast.
	flock -w 5 200 || { log_hook_error "flock timeout on recent-edits" "post-edit.sh"; exit 0; }
	if [[ ! -f "${EDITS_FILE}" ]]; then
		echo '{"files":{}}' >"${EDITS_FILE}"
	fi
	TMP_FILE=$(mktemp)
	jq --arg file "${FILE_PATH}" --arg ts "${TIMESTAMP}" \
		'.files[$file] = $ts' \
		"${EDITS_FILE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${EDITS_FILE}"
) 200>"${EDITS_FILE}.lock"

# Defensive empty JSON response for pre-v2.1.119 platforms where async hooks
# emitting no stdout wrote empty transcript entries. Safe to emit on all versions.
printf '{}\n'
exit 0
