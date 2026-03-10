#!/bin/bash

INPUT=$(cat)

COMMAND=$(echo "${INPUT}" | jq -r '.tool_input.command // ""' 2>/dev/null)

if [[ -z "${COMMAND}" ]]; then
	exit 0
fi

# Leading whitespace strip has no clean parameter expansion equivalent
# shellcheck disable=SC2001
TRIMMED_CMD=$(echo "${COMMAND}" | sed 's/^[[:space:]]*//')

if [[ "${TRIMMED_CMD}" == rm\ -rf\ * ]] || [[ "${TRIMMED_CMD}" == rm\ -r\ * ]]; then
	echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Destructive rm -rf operation blocked. Use explicit file deletion instead."}}}'
	exit 0
fi

if [[ "${TRIMMED_CMD}" == npm\ * ]] ||
	[[ "${TRIMMED_CMD}" == bun\ * ]] ||
	[[ "${TRIMMED_CMD}" == yarn\ * ]] ||
	[[ "${TRIMMED_CMD}" == pnpm\ * ]]; then
	echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
	exit 0
fi

exit 0
