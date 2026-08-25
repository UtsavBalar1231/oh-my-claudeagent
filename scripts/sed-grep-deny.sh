#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

# Translate a denied `grep` invocation into the equivalent `rg` one, so a gate can
# rewrite the call instead of spending a deny-and-retry round trip on it.
# The translated set is deliberately tiny: a deny costs one retry, a wrong rewrite
# silently runs a different command than the caller asked for. Refused shapes are
# anything but a single simple command (the operand tail is copied through byte for
# byte, so a separator, redirect, substitution, or expansion could move meaning
# outside it), a command word other than exactly `grep`, and any flag that is not a
# clustered short flag spelled identically by rg. `r`/`R` are dropped since rg
# recurses by default.
# Recursive rg skips gitignored, hidden, and binary files where recursive grep does
# not; that divergence is accepted because rg is already the search posture this
# plugin tells callers to use. An explicitly named file is searched by rg regardless
# of ignore rules, so the single-file form is exact.
# Arguments:
#   $1 - the raw command string
# Outputs:
#   The rewritten `rg ...` command on STDOUT, no trailing newline.
# Returns:
#   0 when translated, 1 when the caller must keep denying.
grep_to_rg() {
	local cmd="$1" rest tok cluster keep flags="" i ch
	local -a tail_tokens
	local UNSAFE_SHELL_CHARS=$'[;&|<>`()$\n\r]'
	[[ "${cmd}" =~ ${UNSAFE_SHELL_CHARS} ]] && return 1
	rest="${cmd#"${cmd%%[![:space:]]*}"}"
	[[ "${rest}" == grep[[:space:]]* ]] || return 1
	rest="${rest#grep}"
	while true; do
		rest="${rest#"${rest%%[![:space:]]*}"}"
		[[ -n "${rest}" ]] || return 1
		tok="${rest%%[[:space:]]*}"
		[[ "${tok}" == -* ]] || break
		[[ "${tok}" =~ ^-[a-zA-Z]+$ ]] || return 1
		cluster="${tok#-}"
		keep=""
		for ((i = 0; i < ${#cluster}; i++)); do
			ch="${cluster:i:1}"
			case "${ch}" in
			r | R) ;;
			n | i | w | v | c | l | F | H | h) keep+="${ch}" ;;
			*) return 1 ;;
			esac
		done
		[[ -n "${keep}" ]] && flags+=" -${keep}"
		rest="${rest#"${tok}"}"
	done
	# `read -ra` splits without globbing, so a `*.py` operand is not expanded here.
	read -ra tail_tokens <<< "${rest}"
	for tok in "${tail_tokens[@]}"; do
		tok="${tok#[\'\"]}"
		[[ "${tok}" == -* ]] && return 1
	done
	printf 'rg%s %s' "${flags}" "${rest}"
}

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
# A separator inside a quoted span is blanked first, so a multi-line commit
# message whose inner line begins with `sed -n` is a mention, not an invocation.
SCAN_CMD=$(neutralize_quoted_positions "${CMD}")
CMD_POSITION_RE=$'(^|[;&|`\n\r]|[$]\\()[[:space:]]*'
if [[ "${SCAN_CMD}" =~ ${CMD_POSITION_RE}sed[[:space:]]+-[[:alnum:]]*n[[:alnum:]]*([[:space:]]|$) ]] \
	|| [[ "${SCAN_CMD}" =~ ${CMD_POSITION_RE}grep[[:space:]]+-[[:alnum:]]*n[[:alnum:]]*([[:space:]]|$) ]]; then
	# A grep the translator vouches for is rewritten rather than refused: its intent is
	# unambiguous, so a deny would only buy a round trip. `updatedInput` replaces the
	# whole input object, so the original tool_input is carried forward with `command`
	# swapped; enumerating the Bash fields here would drop any the caller sent that
	# this script does not know about.
	if REWRITTEN=$(grep_to_rg "${CMD}"); then
		ALLOW_REASON="Rewrote the denied grep to: ${REWRITTEN}"
		if [[ "${HOOK_EVENT}" == "PreToolUse" ]]; then
			jq -c --arg reason "${ALLOW_REASON}" --arg cmd "${REWRITTEN}" \
				'{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: $reason, updatedInput: (.tool_input | .command = $cmd)}}' \
				<<< "${HOOK_INPUT}"
		else
			jq -c --arg cmd "${REWRITTEN}" \
				'{hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "allow", updatedInput: (.tool_input | .command = $cmd)}}}' \
				<<< "${HOOK_INPUT}"
		fi
		exit 0
	fi
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
