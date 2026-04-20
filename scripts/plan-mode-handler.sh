#!/bin/bash
# PermissionRequest handler for ExitPlanMode
# Auto-approves plan exit and switches session to acceptEdits mode.
# Compensates for permissionMode being stripped from plugin subagents (CC v2.1.77+).
# NOTE: PermissionRequest hooks do NOT fire in headless/non-interactive mode (-p).
# SAFETY: This auto-approve is safe because the upstream prometheus workflow
# gates ExitPlanMode behind AskUserQuestion — the user must explicitly choose
# "Start implementation" before ExitPlanMode is called. If this assumption
# is violated, this log line provides an audit trail.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

TOOL_NAME=$(jq -r '.tool_name // ""' <<< "${HOOK_INPUT}")

if [[ "${TOOL_NAME}" == "ExitPlanMode" ]]; then
	echo "[plan-mode-handler] Auto-approved ExitPlanMode — upstream AskUserQuestion gate assumed" >&2
	echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}'
	exit 0
fi

exit 0
