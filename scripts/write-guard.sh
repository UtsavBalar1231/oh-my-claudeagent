#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

FILE_PATH=$(jq -r '.tool_input.file_path // ""' <<< "${HOOK_INPUT}")

if [[ -z "${FILE_PATH}" ]]; then
	exit 0
fi

case "${FILE_PATH}" in
*/verification-evidence.json)
	jq -nc \
		--arg reason "Manual writes to verification-evidence.json are forbidden. Use the evidence_log MCP tool instead." \
		'{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
	exit 0
	;;
*) ;;
esac

if [[ -f "${FILE_PATH}" ]]; then
	MSG="Detected manual write to file that exists at path ${FILE_PATH}. Future modifications should use Edit to preserve history."
	emit_context "PreToolUse" "${MSG}"
else
	exit 0
fi
