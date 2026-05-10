#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"


COMMAND=$(jq -r '.tool_input.command // ""' <<< "${HOOK_INPUT}")

if [[ -z "${COMMAND}" ]]; then
	exit 0
fi

# Strip leading whitespace (sed for readability over parameter expansion)
# shellcheck disable=SC2001
TRIMMED_CMD=$(echo "${COMMAND}" | sed 's/^[[:space:]]*//')

if [[ "${TRIMMED_CMD}" =~ ^(sudo[[:space:]]+)?rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*[[:space:]] ]]; then
	echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Destructive rm -rf operation blocked. Use explicit file deletion instead."}}}'
	exit 0
fi

# Auto-allow JS package manager safe subcommands (lockfile-only / read-only / run-only).
# Blocked: install <pkg>, publish, exec, npx <pkg> — fall through to user decision.
# Safe set: run *, test, ci, list, view (npm); run *, test (bun/yarn/pnpm).
for _PM in npm bun yarn pnpm; do
	if [[ "${TRIMMED_CMD}" == ${_PM}\ * ]]; then
		_SUBCMD="${TRIMMED_CMD#${_PM} }"
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
