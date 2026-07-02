#!/usr/bin/env bash
# PostToolUseFailure handler for Read tool failures
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

ERROR=$(jq -r '.error // ""' <<< "${HOOK_INPUT}")
TOOL_NAME=$(jq -r '.tool_name // "Read"' <<< "${HOOK_INPUT}")
ERROR_COUNTS_FILE="${HOOK_STATE_DIR}/error-counts.json"
ERROR_KEY="${TOOL_NAME}:read_error"

if echo "${ERROR}" | grep -qiE 'no such file|not found|ENOENT'; then
	ADVICE="File not found. Use Glob to search for similar filenames, or check if the path has changed."
elif echo "${ERROR}" | grep -qiE 'permission|EACCES'; then
	ADVICE="Permission denied. The file exists but cannot be read. Use the file_read MCP tool (via ToolSearch) for files outside the project root. Fallback: Bash(cat /path) if MCP tools are unavailable."
elif echo "${ERROR}" | grep -qiE 'directory|is a directory'; then
	ADVICE="Path is a directory, not a file. Use Bash(ls ...) to list contents, or Glob to find files within."
else
	exit 0
fi

NEW_COUNT=$(error_count_bump "${ERROR_KEY}" "${ERROR}")

# 3 — circuit-breaker threshold: two failures are retriable (stale path, transient); third signals a stuck loop.
CIRCUIT_BREAKER=""
if [[ "${NEW_COUNT}" -ge 3 ]]; then
	TIMELINE=$(jq -r --arg key "${ERROR_KEY}" \
		'(.[$key].last_errors // []) | reverse | to_entries | map("\(.key + 1)) \(.value)") | join(" ")' \
		"${ERROR_COUNTS_FILE}" 2>/dev/null)
	CIRCUIT_BREAKER=" This error has occurred 3+ times. Attempts: ${TIMELINE}. Stop retrying the same approach. Escalate to oracle for architectural guidance or try a fundamentally different approach."
fi

emit_context "PostToolUseFailure" "[READ ERROR RECOVERY] ${ADVICE}${CIRCUIT_BREAKER}"
