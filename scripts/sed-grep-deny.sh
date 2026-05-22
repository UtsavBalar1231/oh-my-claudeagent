#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

CMD=$(jq -r '.tool_input.command // ""' <<< "${HOOK_INPUT}")

if [[ -z "${CMD}" ]]; then
	exit 0
fi

# Deny `sed -n` (with optional clustered short flags like -ne, -nqp) OR
# `grep -n` (with optional clustered short flags like -nA, -nB, -nC).
# Pattern: command word followed by one or more flag clusters that include `n`.
# [[:alnum:]]* before/after `n` allows clusters like -ne, -nA, -rn, -nB3 are
# caught because the flag group contains n.
if [[ "${CMD}" =~ (^|[[:space:]])sed[[:space:]]+-[[:alnum:]]*n[[:alnum:]]*([[:space:]]|$) ]] \
	|| [[ "${CMD}" =~ (^|[[:space:]])grep[[:space:]]+-[[:alnum:]]*n[[:alnum:]]*([[:space:]]|$) ]]; then
	echo "\`sed -n\` and \`grep -n\` are denied. Use the Grep tool, Read with offset/limit, or ast_search for structural matches." >&2
	exit 2
fi

echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
exit 0
