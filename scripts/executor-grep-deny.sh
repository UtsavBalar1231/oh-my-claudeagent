#!/bin/bash
# executor-grep-deny.sh — deny Grep/Bash-grep on code files when running inside an executor subagent.
# Fires on PreToolUse (Grep) and PermissionRequest (Bash grep *).
# Executor must use ast_search for structural queries; plain text-grep on code is denied.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

# CODE_EXT_REGEX — extensions for which grep on code is denied.
# Non-code files (.txt .json .yaml .toml .log .lock etc.) pass through.
CODE_EXT_REGEX='\.(py|ts|tsx|js|jsx|go|rs|java|kt|swift|c|cpp|h|hpp|md)$'

TOOL_NAME=$(jq -r '.tool_name // ""' <<< "${HOOK_INPUT}")

# Only act on Grep and Bash tool events.
case "${TOOL_NAME}" in
Grep | Bash) ;;
*)
	exit 0
	;;
esac

pass() {
	exit 0
}

AGENT_ID=$(jq -r '.agent_id // ""' <<< "${HOOK_INPUT}")

if [[ -z "${AGENT_ID}" || "${AGENT_ID}" == "null" ]]; then
	pass
fi

AGENT_TYPE=$(jq -r '.agent_type // ""' <<< "${HOOK_INPUT}")

# Normalize: strip plugin namespace prefix if present.
AGENT_TYPE_NORM="${AGENT_TYPE##*:}"

if [[ "${AGENT_TYPE_NORM}" != "executor" ]]; then
	pass
fi

HOOK_EVENT=$(jq -r '.hook_event_name // "PermissionRequest"' <<< "${HOOK_INPUT}")

DENY_REASON="Executor must use ast_search for structural queries against code files. Plain text-grep on code is denied."

# ── Executor path: check tool ──────────────────────────────────────────────────
deny_grep() {
	if [[ "${HOOK_EVENT}" == "PreToolUse" ]]; then
		echo "${DENY_REASON}" >&2
		exit 2
	fi
	jq -nc --arg reason "${DENY_REASON}" \
		'{hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "deny", message: $reason}}}'
	exit 0
}

case "${TOOL_NAME}" in
Grep)
	# Check tool_input.glob and tool_input.path for code-file extensions.
	GLOB=$(jq -r '.tool_input.glob // ""' <<< "${HOOK_INPUT}")
	PATH_ARG=$(jq -r '.tool_input.path // ""' <<< "${HOOK_INPUT}")
	if [[ "${GLOB}" =~ ${CODE_EXT_REGEX} ]] || [[ "${PATH_ARG}" =~ ${CODE_EXT_REGEX} ]]; then
		deny_grep
	fi
	;;
Bash)
	CMD=$(jq -r '.tool_input.command // ""' <<< "${HOOK_INPUT}")
	# A separator inside a quoted span is blanked first, so a multi-line commit
	# message whose inner line begins with `grep` is a mention, not an invocation.
	SCAN_CMD=$(neutralize_quoted_positions "${CMD}")
	GREP_AT_COMMAND_POSITION_RE=$'(^|[;&|(`\n\r]|[$]\\()[[:space:]]*(sudo[[:space:]]+)?grep([^a-zA-Z_]|$)'
	if [[ ! "${SCAN_CMD}" =~ ${GREP_AT_COMMAND_POSITION_RE} ]]; then
		pass
	fi
	# Check if any token in the command is a filename ending in a code extension.
	if [[ "${CMD}" =~ ${CODE_EXT_REGEX} ]]; then
		deny_grep
	fi
	;;
*)
	;;
esac

pass
