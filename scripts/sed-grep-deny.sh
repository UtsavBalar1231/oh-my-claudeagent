#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

if hook_is_disabled "sed-grep-deny"; then
	log_hook_info "Disabled via OMCA_DISABLED_HOOKS — skipping sed/grep check." "$(basename "$0")"
	exit 0
fi

CMD=$(jq -r '.tool_input.command // ""' <<< "${HOOK_INPUT}")

HOOK_EVENT=$(jq -r '.hook_event_name // "PermissionRequest"' <<< "${HOOK_INPUT}")

if [[ -z "${CMD}" ]]; then
	exit 0
fi

DENY_REASON="\`sed -n\` and \`grep -n\` are denied. Use the Grep tool, Read with offset/limit, or ast_search for structural matches."

# Deny `sed -n` (with optional clustered short flags like -ne, -nqp) OR
# `grep -n` (with optional clustered short flags like -nA, -nB, -nC).
# Pattern: command word followed by one or more flag clusters that include `n`.
# [[:alnum:]]* before/after `n` allows clusters like -ne, -nA, -rn, -nB3 are
# caught because the flag group contains n.
CMD_POSITION_RE=$'(^|[;&|`\n\r]|[$]\\()[[:space:]]*'
if [[ "${CMD}" =~ ${CMD_POSITION_RE}sed[[:space:]]+-[[:alnum:]]*n[[:alnum:]]*([[:space:]]|$) ]] \
	|| [[ "${CMD}" =~ ${CMD_POSITION_RE}grep[[:space:]]+-[[:alnum:]]*n[[:alnum:]]*([[:space:]]|$) ]]; then
	if [[ "${HOOK_EVENT}" == "PreToolUse" ]]; then
		jq -nc --arg reason "${DENY_REASON}" \
			'{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
	else
		jq -nc --arg reason "${DENY_REASON}" \
			'{hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "deny", message: $reason}}}'
	fi
	exit 0
fi

exit 0
