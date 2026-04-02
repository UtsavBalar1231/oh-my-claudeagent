#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"

emit_context() {
	local message="$1"
	jq -nc --arg msg "${message}" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $msg}}'
}

FILE_PATH=$(echo "${INPUT}" | jq -r '.tool_input.file_path // ""' 2>/dev/null)

if [[ -z "${FILE_PATH}" ]]; then
	exit 0
fi

# Intercept manual writes to verification-evidence.json
case "${FILE_PATH}" in
*/verification-evidence.json)
	MSG="[EVIDENCE GUARD] Do NOT manually write verification-evidence.json. Use the evidence_log MCP tool instead. Example: evidence_log(evidence_type=\"test\", command=\"just test\", exit_code=0, output_snippet=\"10 passed\")"
	emit_context "${MSG}"
	exit 0
	;;
*) ;;
esac

if [[ -f "${FILE_PATH}" ]]; then
	MSG="[WRITE GUARD] File already exists: ${FILE_PATH}. Consider using Edit tool for modifications to preserve existing content."
	emit_context "${MSG}"
else
	exit 0
fi
