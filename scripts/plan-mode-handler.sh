#!/bin/bash
# PermissionRequest handler for ExitPlanMode
# Auto-approves plan exit and switches session to acceptEdits mode.
# Compensates for permissionMode being stripped from plugin subagents (CC v2.1.77+).
# NOTE: PermissionRequest hooks do NOT fire in headless/non-interactive mode (-p).
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"
TOOL_NAME=$(echo "${INPUT}" | jq -r '.tool_name // ""' 2>/dev/null)

if [[ "${TOOL_NAME}" == "ExitPlanMode" ]]; then
	echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}'
	exit 0
fi

exit 0
