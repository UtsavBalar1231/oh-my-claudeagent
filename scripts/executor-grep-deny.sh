#!/bin/bash
# executor-grep-deny.sh — deny Grep/Bash-grep on code files when running inside an executor subagent.
# Fires on PreToolUse (Grep) and PermissionRequest (Bash grep *).
# Executor must use ast_search for structural queries; plain text-grep on code is denied.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
SUBAGENTS_FILE="${STATE_DIR}/subagents.json"

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

# allow_pass — emit PermissionRequest allow JSON for Bash events; silent exit for Grep (PreToolUse).
allow_pass() {
	if [[ "${TOOL_NAME}" == "Bash" ]]; then
		echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
	fi
	exit 0
}

# ── Resolve subagent type ──────────────────────────────────────────────────────
# 1. Try explicit subagent_type on the payload (present on some events).
# 2. Fall back to agent_id lookup in subagents.json .active[].type.
# If neither resolves to executor, allow.
AGENT_TYPE=$(jq -r '.subagent_type // ""' <<< "${HOOK_INPUT}")

if [[ -z "${AGENT_TYPE}" || "${AGENT_TYPE}" == "null" ]]; then
	AGENT_ID=$(jq -r '.agent_id // ""' <<< "${HOOK_INPUT}")
	if [[ -z "${AGENT_ID}" || "${AGENT_ID}" == "null" ]]; then
		# No agent context — main session tool call; allow.
		allow_pass
	fi

	if [[ ! -f "${SUBAGENTS_FILE}" ]]; then
		allow_pass
	fi

	# flock-protected read — avoids race with subagent-start.sh write.
	# 5s — flock wait; long enough for concurrent siblings, short enough to fail fast.
	# shellcheck disable=SC2016
	AGENT_TYPE=$(
		flock -w 5 "${STATE_DIR}/subagents.lock" \
			jq -r --arg id "${AGENT_ID}" \
				'.active[] | select(.id == $id) | .type // ""' \
				"${SUBAGENTS_FILE}" 2>/dev/null || echo ""
	)
fi

# Normalize: strip plugin namespace prefix if present.
AGENT_TYPE_NORM="${AGENT_TYPE##*:}"

if [[ "${AGENT_TYPE_NORM}" != "executor" ]]; then
	allow_pass
fi

# ── Executor path: check tool ──────────────────────────────────────────────────
deny_grep() {
	echo "Executor must use ast_search for structural queries against code files. Plain text-grep on code is denied." >&2
	exit 2
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
	# Bail if no grep word boundary present.
	if [[ ! "${CMD}" =~ (^|[^a-zA-Z_])grep([^a-zA-Z_]|$) ]]; then
		allow_pass
	fi
	# Check if any token in the command is a filename ending in a code extension.
	if [[ "${CMD}" =~ ${CODE_EXT_REGEX} ]]; then
		deny_grep
	fi
	;;
*)
	;;
esac

allow_pass
