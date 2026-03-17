#!/bin/bash

INPUT=$(cat)

COMMAND=$(echo "${INPUT}" | jq -r '.tool_input.command // ""' 2>/dev/null)

if [[ -z "${COMMAND}" ]]; then
	exit 0
fi

# Strip leading whitespace (sed for readability over parameter expansion)
# shellcheck disable=SC2001
TRIMMED_CMD=$(echo "${COMMAND}" | sed 's/^[[:space:]]*//')

# Catch rm -rf, rm -r, rm -fr, sudo rm variants
if [[ "${TRIMMED_CMD}" =~ ^(sudo[[:space:]]+)?rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*[[:space:]] ]]; then
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

# Auto-allow jq (used by hook scripts)
if [[ "${TRIMMED_CMD}" == jq\ * ]]; then
	echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
	exit 0
fi
# Auto-allow uv run/sync (MCP server startup + dependency management)
if [[ "${TRIMMED_CMD}" == uv\ run\ * ]] || [[ "${TRIMMED_CMD}" == uv\ sync ]] || [[ "${TRIMMED_CMD}" == uv\ sync\ * ]]; then
	echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
	exit 0
fi

exit 0
