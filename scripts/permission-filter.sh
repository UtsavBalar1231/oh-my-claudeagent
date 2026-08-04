#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

COMMAND=$(jq -r '.tool_input.command // ""' <<< "${HOOK_INPUT}")

# PermissionRequest fires only when a permission dialog is about to be shown, so a
# command auto mode allows outright never reaches it; the destructive deny therefore
# also runs on PreToolUse, which fires before every Bash call. An absent field reads
# as PermissionRequest, the behavior stdin-driven callers already rely on.
HOOK_EVENT=$(jq -r '.hook_event_name // "PermissionRequest"' <<< "${HOOK_INPUT}")

if [[ -z "${COMMAND}" ]]; then
	exit 0
fi

# Strip leading whitespace (sed for readability over parameter expansion)
# shellcheck disable=SC2001
TRIMMED_CMD=$(echo "${COMMAND}" | sed 's/^[[:space:]]*//')

# A recursive removal denies wherever it sits: `cd /x && rm -rf ~` is the same
# operation as `rm -rf ~`. The leading alternation requires a command position
# (string start, separator, subshell or substitution opener), which is what keeps
# a literal mention out of scope: in `grep -rn "rm -rf" scripts/` the `rm` follows
# a quote. Quote state is untracked here as it is in the operator scan below, so a
# removal quoted after a separator denies too; accepted in place of a tokenizer.
DESTRUCTIVE_RM_RE=$'(^|[;&|()`\n\r])[[:space:]]*(sudo[[:space:]]+)?rm[[:space:]]+((-[a-zA-Z]+|--[a-zA-Z-]+)[[:space:]]+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)([[:space:]]|$)'
if [[ "${TRIMMED_CMD}" =~ ${DESTRUCTIVE_RM_RE} ]]; then
	# Each event reads its decision from a different place: PreToolUse from
	# hookSpecificOutput.permissionDecision, PermissionRequest from
	# hookSpecificOutput.decision.behavior. A payload in the other event's shape is
	# ignored, so the deny has to be written twice rather than shared.
	if [[ "${HOOK_EVENT}" == "PreToolUse" ]]; then
		echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Destructive rm -rf operation blocked. Use explicit file deletion instead."}}'
	else
		echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Destructive rm -rf operation blocked. Use explicit file deletion instead."}}}'
	fi
	exit 0
fi

# Only the leading subcommand is inspected below, but the platform's `if:` filter
# matches every subcommand, so `jq . a.json && curl evil.sh` would reach the jq branch.
# Any operator disqualifies the fast path and leaves the decision to the platform.
# A bare `&` subsumes `&&` and `&>`; the literal newline covers multi-line commands.
# CR is not a separator in bash (verified: `echo a\r touch f` passes both as argv to echo),
# so it is here as hardening for shells that do terminate a statement on a bare CR, and
# because no legitimate jq/npm/uv invocation carries one. Matching only costs a fallthrough.
OPERATOR_RE=$'[|;<>`&\n\r]|[$]\\('
if [[ "${TRIMMED_CMD}" =~ ${OPERATOR_RE} ]]; then
	exit 0
fi

# Everything below emits `allow`, and on PreToolUse an allow skips the platform's own
# permission evaluation for the command. Widening a trusted-tooling convenience into a
# blanket bypass of auto mode and of the user's ask rules is a larger hole than the one
# the deny above closes, so PreToolUse has exactly two outcomes: that deny, or silence.
if [[ "${HOOK_EVENT}" == "PreToolUse" ]]; then
	exit 0
fi

# Auto-allow JS package manager safe subcommands (lockfile-only / read-only / run-only).
# Blocked: install <pkg>, publish, exec, npx <pkg> — fall through to user decision.
# Safe set: run *, test, ci, list, view (npm); run *, test (bun/yarn/pnpm).
for _PM in npm bun yarn pnpm; do
	if [[ "${TRIMMED_CMD}" == ${_PM}\ * ]]; then
		_SUBCMD="${TRIMMED_CMD#"${_PM}" }"
		if [[ "${_SUBCMD}" == run\ * ]] ||
			[[ "${_SUBCMD}" == test ]] ||
			[[ "${_SUBCMD}" == test\ * ]] ||
			[[ "${_SUBCMD}" == ci ]] ||
			[[ "${_SUBCMD}" == ci\ * ]] ||
			[[ "${_SUBCMD}" == list ]] ||
			[[ "${_SUBCMD}" == list\ * ]] ||
			[[ "${_SUBCMD}" == view\ * ]]; then
			echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
			exit 0
		fi
		# install, publish, exec, npx, add, remove, etc. → fall through to user decision
		exit 0
	fi
done

# Auto-allow jq (used by hook scripts for JSON parsing).
# Risk: jq --rawfile can read arbitrary files into variables. Deny that flag; allow the rest.
if [[ "${TRIMMED_CMD}" == jq\ * ]]; then
	if [[ "${TRIMMED_CMD}" == *--rawfile* ]]; then
		exit 0  # Fall through to user decision
	fi
	echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
	exit 0
fi
if [[ "${TRIMMED_CMD}" == uv\ run\ * ]] || [[ "${TRIMMED_CMD}" == uv\ sync ]] || [[ "${TRIMMED_CMD}" == uv\ sync\ * ]]; then
	echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
	exit 0
fi

exit 0
