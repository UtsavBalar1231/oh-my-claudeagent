#!/bin/bash
# git-destructive-deny.sh — blocks destructive git commands that discard working tree changes.
# Denied: git reset --hard, git stash*, git checkout --, git clean*, git restore*.
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

# PermissionRequest fires only when a permission dialog is about to be shown, so a
# command auto mode allows outright never reaches it; the deny therefore also runs on
# PreToolUse, which fires before every Bash call. An absent field reads as
# PermissionRequest, the behavior stdin-driven callers already rely on.
HOOK_EVENT=$(jq -r '.hook_event_name // "PermissionRequest"' <<< "${HOOK_INPUT}")

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
DESTRUCTIVE_GIT_RE=$'(^|[;&|()`\n\r])[[:space:]]*(sudo[[:space:]]+)?git[[:space:]]+(reset[[:space:]]+--hard|stash|clean|restore|checkout[[:space:]]+--)([[:space:]);&|<>`\n\r]|$)'
if [[ "${CMD}" =~ ${DESTRUCTIVE_GIT_RE} ]]; then
	echo "Destructive git command blocked. If working tree is dirty, REPORT and STOP — never modify history. Set OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY=1 to override for testing." >&2
	exit 2
fi

# The allow below covers every git command this hook did not deny, so it must not
# speak for a command that carries a second one: `if: "Bash(git *)"` only inspects
# the head, and an allow here outranks the platform prompt that `git status && curl
# ... | sh` would otherwise get. Any operator leaves the decision to the platform.
# Mirrors the operator scan in permission-filter.sh, including the bare-CR
# hardening and the same quote-blindness.
OPERATOR_RE=$'[|;<>`&\n\r]|[$]\\('
if [[ "${CMD}" =~ ${OPERATOR_RE} ]]; then
	exit 0
fi

# On PreToolUse an allow skips the platform's own permission evaluation, so allowing
# every git command this hook did not deny would bypass auto mode and the user's ask
# rules for the whole of git. PreToolUse has exactly two outcomes here: the exit-2
# block above, or silence. The exit 2 works on both events, so it needs no branch.
if [[ "${HOOK_EVENT}" == "PreToolUse" ]]; then
	exit 0
fi

echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
exit 0
