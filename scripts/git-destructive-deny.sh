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

if [[ -z "${CMD}" ]]; then
	exit 0
fi

# Strip leading whitespace
# shellcheck disable=SC2001
CMD=$(echo "${CMD}" | sed 's/^[[:space:]]*//')

# The destructive subcommand denies at any command position, not only the head of
# the string: `git status && git reset --hard` discards the same working tree as
# `git reset --hard`. Requiring a command position in front of it keeps a literal
# mention out of scope, so a message or search pattern naming the subcommand does
# not deny. Quote state is untracked, as in permission-filter.sh.
# The optional `sudo` mirrors the one in permission-filter.sh: without it `sudo git
# clean -fdx` carried no operator, so it reached the trailing allow and was auto
# approved. The trailing class ends the subcommand on any separator rather than on
# whitespace alone, so `git stash; echo ok` and `echo $(git stash)` deny while
# `git cleanup` and `git checkout --detach` stay out of scope.
DESTRUCTIVE_GIT_GLOBALS='((-C[[:space:]]+[^[:space:]]+|-c[[:space:]]+[^[:space:]]+|--git-dir=[^[:space:]]+|--work-tree=[^[:space:]]+)[[:space:]]+)*'
DESTRUCTIVE_GIT_SUBCMD=$'(reset["\']?[[:space:]]+--hard|stash|clean|restore|rm|checkout([[:space:]]+[^[:space:];&|`\n\r]+)*[[:space:]]+--)'
DESTRUCTIVE_GIT_RE=$'(^|[;&|`\n\r]|[$]\\()[[:space:]]*(sudo[[:space:]]+)?git[[:space:]]+'
DESTRUCTIVE_GIT_RE+="${DESTRUCTIVE_GIT_GLOBALS}"$'["\']?'"${DESTRUCTIVE_GIT_SUBCMD}"$'["\']?([[:space:]);&|<>`\n\r]|$)'
if [[ "${CMD}" =~ ${DESTRUCTIVE_GIT_RE} ]]; then
	echo "Destructive git command blocked. If working tree is dirty, REPORT and STOP — never modify history. Set OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY=1 to override for testing." >&2
	exit 2
fi

exit 0
