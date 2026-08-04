#!/bin/bash
# git-destructive-deny.sh — blocks destructive git commands that discard working tree changes.
# Opt-out: OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY=1.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

if hook_is_disabled "git-destructive-deny"; then
	log_hook_info "Disabled via OMCA_DISABLED_HOOKS — skipping destructive-git check." "$(basename "$0")"
	exit 0
fi

if [[ "${OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY:-}" == "1" ]]; then
	log_hook_info "Opt-out active (OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY=1) — skipping destructive-git check." "$(basename "$0")"
	exit 0
fi

CMD=$(jq -r '.tool_input.command // ""' <<< "${HOOK_INPUT}")

HOOK_EVENT=$(jq -r '.hook_event_name // "PermissionRequest"' <<< "${HOOK_INPUT}")

if [[ -z "${CMD}" ]]; then
	exit 0
fi

# Strip leading whitespace
# shellcheck disable=SC2001
CMD=$(echo "${CMD}" | sed 's/^[[:space:]]*//')

neutralize_quoted_positions() {
	local s="$1" out="" quote="" ch i
	for ((i = 0; i < ${#s}; i++)); do
		ch="${s:i:1}"
		if [[ -n "${quote}" ]]; then
			if [[ "${ch}" == "${quote}" ]]; then
				quote=""
			elif [[ "${ch}" == [\;\&\|\(\)] || "${ch}" == $'\n' || "${ch}" == $'\r' ]]; then
				ch="_"
			elif [[ "${quote}" == "'" && ("${ch}" == '$' || "${ch}" == '`') ]]; then
				ch="_"
			fi
		elif [[ "${ch}" == "'" || "${ch}" == '"' ]]; then
			quote="${ch}"
		fi
		out+="${ch}"
	done
	printf '%s' "${out}"
}

SCAN_CMD=$(neutralize_quoted_positions "${CMD}")

# The destructive subcommand denies at any command position, not only the head of
# the string: `git status && git reset --hard` discards the same working tree as
# `git reset --hard`. Requiring a command position in front of it keeps a literal
# mention out of scope, so a message or search pattern naming the subcommand does
# not deny. Characters that would open a command position inside a quoted span are
# blanked first, so a quoted mention cannot look like one.
# The optional `sudo` mirrors the one in permission-filter.sh: without it `sudo git
# clean -fdx` carried no operator, so it reached the trailing allow and was auto
# approved. The trailing class ends the subcommand on any separator rather than on
# whitespace alone, so `git stash; echo ok` and `echo $(git stash)` deny while
# `git cleanup` and `git checkout --detach` stay out of scope.
DESTRUCTIVE_GIT_GLOBALS='((-C[[:space:]]+[^[:space:]]+|-c[[:space:]]+[^[:space:]]+|-c[^[:space:]]+|--git-dir[=[:space:]][^[:space:]]+|--work-tree[=[:space:]][^[:space:]]+|--no-pager|--paginate|-p|--bare|--literal-pathspecs|--no-replace-objects)[[:space:]]+)*'
DESTRUCTIVE_GIT_SUBCMD=$'(reset["\']?[[:space:]]+--hard|stash|clean|restore|rm[[:space:]]+-[a-zA-Z]*[rR][a-zA-Z]*|checkout([[:space:]]+[^[:space:];&|`\n\r]+)*[[:space:]]+--)'
DESTRUCTIVE_GIT_RE=$'(^|[;&|(`\n\r]|[$]\\()[[:space:]]*(sudo[[:space:]]+)?git[[:space:]]+'
DESTRUCTIVE_GIT_RE+="${DESTRUCTIVE_GIT_GLOBALS}"$'["\']?'"${DESTRUCTIVE_GIT_SUBCMD}"$'["\']?([[:space:]);&|<>`\n\r]|$)'
DENY_REASON="Destructive git command blocked. If working tree is dirty, REPORT and STOP — never modify history. Set OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY=1 to override for testing."
if [[ "${SCAN_CMD}" =~ ${DESTRUCTIVE_GIT_RE} ]]; then
	if [[ "${HOOK_EVENT}" == "PreToolUse" ]]; then
		echo "${DENY_REASON}" >&2
		exit 2
	fi
	jq -nc --arg reason "${DENY_REASON}" \
		'{hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "deny", message: $reason}}}'
	exit 0
fi

exit 0
