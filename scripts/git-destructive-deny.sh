#!/bin/bash
# git-destructive-deny.sh — blocks destructive git commands that discard working tree changes.
# Denied: git reset --hard, git stash*, git checkout --, git clean*, git restore*.
# Opt-out: OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY=1.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

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

if [[ "${CMD}" =~ ^git[[:space:]]+(reset[[:space:]]+--hard|stash([[:space:]]|$)|checkout[[:space:]]+--|clean([[:space:]]|$)|restore([[:space:]]|$)) ]]; then
	echo "Destructive git command blocked. If working tree is dirty, REPORT and STOP — never modify history. Set OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY=1 to override for testing." >&2
	exit 2
fi

echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
exit 0
