#!/usr/bin/env bash
# PostToolUseFailure handler for Read tool failures
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

ERROR=$(jq -r '.error // ""' <<< "${HOOK_INPUT}")
TOOL_NAME=$(jq -r '.tool_name // "Read"' <<< "${HOOK_INPUT}")
ERROR_COUNTS_FILE="${HOOK_STATE_DIR}/error-counts.json"
ERROR_KEY="${TOOL_NAME}:read_error"

if echo "${ERROR}" | grep -qiE 'no such file|not found|ENOENT'; then
	ADVICE="File not found. Search for the name with find or rg --files, or check whether the path changed."
elif echo "${ERROR}" | grep -qiE 'permission|EACCES'; then
	ADVICE="Permission denied. For a path outside the working directories, read it with mcp__plugin_oh-my-claudeagent_omca__file_read, or ask the user to add its directory with /add-dir. If the file's own permissions forbid reading (EACCES), no tool will read it: report that instead of retrying."
elif echo "${ERROR}" | grep -qiE 'directory|is a directory'; then
	ADVICE="Path is a directory, not a file. List it with ls, or search inside it with find or rg --files."
else
	exit 0
fi

NEW_COUNT=$(error_count_bump "${ERROR_KEY}" "${ERROR}")

# 3: circuit-breaker threshold: two failures are retriable (stale path, transient); third signals a stuck loop.
CIRCUIT_BREAKER=""
if [[ "${NEW_COUNT}" -ge 3 ]]; then
	TIMELINE=$(jq -r --arg key "${ERROR_KEY}" \
		'(.[$key].last_errors // []) | reverse | to_entries | map("\(.key + 1)) \(.value)") | join(" ")' \
		"${ERROR_COUNTS_FILE}" 2>/dev/null)
	CIRCUIT_BREAKER=" This tool has failed 3+ times, each failure within five minutes of the last. Attempts: ${TIMELINE}. The count covers every failure of the tool, related or not. If these are repeated attempts at one fix, stop repeating it: change the approach, or ask for a diagnosis, from the advisor tool when you have it and from oracle when you do not."
fi

emit_context "PostToolUseFailure" "[READ ERROR RECOVERY] ${ADVICE}${CIRCUIT_BREAKER}"
