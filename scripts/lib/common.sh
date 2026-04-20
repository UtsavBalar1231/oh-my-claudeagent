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

mode_state_name() {
	local mode="$1"
	printf '%s%s' "${mode}" "${HOOK_MODE_STATE_SUFFIX}"
}

mode_state_path() {
	local mode="$1"
	local state_dir="${2:-${HOOK_STATE_DIR}}"
	printf '%s/%s' "${state_dir}" "$(mode_state_name "${mode}")"
}

mode_is_active() {
	local mode="$1"
	local state_dir="${2:-${HOOK_STATE_DIR}}"
	local state_file
	local status

	state_file="$(mode_state_path "${mode}" "${state_dir}")"
	if [[ ! -f "${state_file}" ]]; then
		return 1
	fi

	status=$(jq -r '.status // "inactive"' "${state_file}" 2>/dev/null || echo "")
	[[ "${status}" == "active" ]]
}

# Compute the absolute path of the completion sidecar for a given plan file.
# Usage: compute_sidecar_path <plan_path>
# Prints: $CLAUDE_PROJECT_ROOT/.omca/notes/<plan-basename-without-.md>-completion.md
compute_sidecar_path() (
	plan_path="$1"
	base=$(basename "$plan_path" .md)
	root=${CLAUDE_PROJECT_ROOT:-$(pwd)}
	printf '%s/.omca/notes/%s-completion.md' "$root" "$base"
)

# Check whether it is safe to overwrite an existing sidecar file.
# Returns 0 (safe) when: no file, no plan_sha256 line, or SHA matches.
# Returns 1 (refuse) when an existing SHA differs from current_sha.
# Usage: check_sidecar_idempotency <sidecar_path> <current_sha>
check_sidecar_idempotency() (
	sidecar_path="$1"
	current_sha="$2"
	[ -f "$sidecar_path" ] || return 0
	while IFS= read -r line; do
		case "$line" in
			plan_sha256:*)
				val=${line#plan_sha256:}
				val=${val# }
				val=${val#\"}
				val=${val%\"}
				[ -z "$val" ] && return 0
				[ "$val" = "$current_sha" ] && return 0
				return 1
				;;
		esac
	done < "$sidecar_path"
	return 0
)

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

# Check whether a sidecar file exists and contains a matching plan_sha256.
# Returns 0 (match) when file exists AND its plan_sha256 line equals expected.
# Returns 1 (no match) when file absent, no plan_sha256 line, or SHA differs.
# Usage: sidecar_sha_matches <sidecar_path> <expected_sha>
sidecar_sha_matches() (
	sidecar_path="$1"
	expected_sha="$2"
	[ -f "$sidecar_path" ] || return 1
	while IFS= read -r line; do
		case "$line" in
			plan_sha256:*)
				val=${line#plan_sha256:}
				val=${val# }
				val=${val#\"}
				val=${val%\"}
				[ "$val" = "$expected_sha" ] && return 0
				return 1
				;;
		esac
	done < "$sidecar_path"
	return 1
)

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
