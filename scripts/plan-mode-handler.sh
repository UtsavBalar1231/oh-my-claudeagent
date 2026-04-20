#!/bin/bash
# PermissionRequest handler for ExitPlanMode — auto-approves and switches to acceptEdits mode.
# NOTE: PermissionRequest hooks do NOT fire in headless/non-interactive mode (-p).
# Safe: upstream prometheus gates ExitPlanMode behind AskUserQuestion; log line is the audit trail.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

TOOL_NAME=$(jq -r '.tool_name // ""' <<< "${HOOK_INPUT}")

if [[ "${TOOL_NAME}" == "ExitPlanMode" ]]; then
	echo "[plan-mode-handler] Auto-approved ExitPlanMode — upstream AskUserQuestion gate assumed" >&2
	echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}'
	exit 0
fi

exit 0
