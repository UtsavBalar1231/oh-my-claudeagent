#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

hook_is_disabled "write-guard" && exit 0

FILE_PATH=$(jq -r '.tool_input.file_path // ""' <<< "${HOOK_INPUT}")

if [[ -z "${FILE_PATH}" ]]; then
	exit 0
fi

MATCH_PATH="${FILE_PATH}"
if NORMALIZED=$(realpath -m -- "${FILE_PATH}" 2>/dev/null); then
	MATCH_PATH="${NORMALIZED}"
fi

case "${MATCH_PATH}" in
*/verification-evidence.json)
	jq -nc \
		--arg reason "Manual writes to verification-evidence.json are forbidden. Use the evidence_log MCP tool instead." \
		'{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
	exit 0
	;;
*/.omca/notepads/*)
	jq -nc \
		--arg reason "notepad files are append-only; Write would destroy history. Use the notepad_write MCP tool." \
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
