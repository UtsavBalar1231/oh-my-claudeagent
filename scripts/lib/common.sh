#!/usr/bin/env bash
if [[ -z "${HOOK_INPUT+x}" ]]; then
	HOOK_INPUT=$(cat)
fi
export HOOK_INPUT

HOOK_PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
HOOK_STATE_DIR="${HOOK_STATE_DIR:-${HOOK_PROJECT_ROOT}/.omca/state}"
HOOK_LOG_DIR="${HOOK_LOG_DIR:-${HOOK_PROJECT_ROOT}/.omca/logs}"
HOOK_MODE_STATE_SUFFIX="-state.json"

mkdir -p "${HOOK_STATE_DIR}" "${HOOK_LOG_DIR}" 2>/dev/null

log_hook_error() {
	local msg="$1"
	local hook_name="${2:-$(basename "$0")}"
	echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"hook\":\"${hook_name}\",\"error\":\"${msg}\"}" >>"${HOOK_LOG_DIR}/hook-errors.jsonl" 2>/dev/null
}

section_header() {
	local title="$1"
	printf '\n─── %s ─────────────────────────────────────\n' "${title}"
}

mode_is_active() {
	local mode="$1"
	local state_dir="${2:-${HOOK_STATE_DIR}}"
	local state_file
	local status

	state_file="${state_dir}/${mode}${HOOK_MODE_STATE_SUFFIX}"
	if [[ ! -f "${state_file}" ]]; then
		return 1
	fi

	status=$(jq -r '.status // "inactive"' "${state_file}" 2>/dev/null || echo "")
	[[ "${status}" == "active" ]]
}

# Session path layout: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
# <encoded-cwd>: working directory with every non-alphanumeric char → "-"
# (e.g. /home/user/my-project → -home-user-my-project; platform-applied, OMCA reads only)
# Resolve session ID: tries CLAUDE_SESSION_ID env, HOOK_INPUT .session_id, session.json .sessionId.
# Prints empty string (returns 0) when none found.
resolve_session_id() {
	local sid
	for sid in "${CLAUDE_SESSION_ID:-}" \
	           "$(jq -r '.session_id // ""' <<< "${HOOK_INPUT:-{}}" 2>/dev/null)" \
	           "$(jq -r '.sessionId // ""' "${HOOK_STATE_DIR:-/nonexistent}/session.json" 2>/dev/null)"; do
		case "${sid}" in
			""|"null"|"unknown") continue ;;
			*) printf '%s\n' "${sid}"; return 0 ;;
		esac
	done
	return 0
}

# Read a JSON field with default. Returns default when file is absent or jq fails.
# Usage: jq_read <file> <jq-expr-with-default>
jq_read() {
	local file="$1"
	local expr="$2"
	if [[ ! -f "${file}" ]]; then
		jq -rn "${expr}" 2>/dev/null || true
		return 0
	fi
	jq -r "${expr}" "${file}" 2>/dev/null || true
}

# Emit hookSpecificOutput JSON with JSON-escaped message.
# Usage: emit_context <hookEventName> <plain-text-message>
emit_context() {
	local event_name="$1"
	local message="$2"
	local escaped
	escaped=$(printf '%s\n' "${message}" | jq -Rs .)
	printf '{"hookSpecificOutput": {"hookEventName": "%s", "additionalContext": %s}}\n' \
		"${event_name}" "${escaped}"
}

# Append a timing entry to hook-timing.jsonl. Write failures are silently suppressed.
# Usage: hook_timing_log <start-ns-timestamp>
hook_timing_log() {
	local start_ns="$1"
	local end_ns ms
	end_ns=$(date +%s%N 2>/dev/null || date +%s)
	ms=$(( (end_ns - start_ns) / 1000000 ))
	echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"hook\":\"$(basename "$0")\",\"ms\":${ms}}" \
		>> "${HOOK_LOG_DIR}/hook-timing.jsonl" 2>/dev/null
}
