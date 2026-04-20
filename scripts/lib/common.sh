#!/usr/bin/env bash
# Shared hook boilerplate — sourced by all hook scripts
# Usage: source "$(dirname "$0")/lib/common.sh"
# For scripts in scripts/lib/ subdir: source "$(dirname "$0")/../lib/common.sh"

# Read hook payload from stdin (exported so sourcing scripts can use it)
# Pre-set HOOK_INPUT (e.g. in tests) is preserved; only read stdin when unset.
if [[ -z "${HOOK_INPUT+x}" ]]; then
	HOOK_INPUT=$(cat)
fi
export HOOK_INPUT

# Project and state paths
HOOK_PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
HOOK_STATE_DIR="${HOOK_STATE_DIR:-${HOOK_PROJECT_ROOT}/.omca/state}"
HOOK_LOG_DIR="${HOOK_LOG_DIR:-${HOOK_PROJECT_ROOT}/.omca/logs}"
HOOK_MODE_STATE_SUFFIX="-state.json"

# Ensure state directories exist
mkdir -p "${HOOK_STATE_DIR}" "${HOOK_LOG_DIR}" 2>/dev/null

# Hook error logging helper
log_hook_error() {
	local msg="$1"
	local hook_name="${2:-$(basename "$0")}"
	echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"hook\":\"${hook_name}\",\"error\":\"${msg}\"}" >>"${HOOK_LOG_DIR}/hook-errors.jsonl" 2>/dev/null
}

# Generate a decorated section header for additionalContext blocks
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
compute_sidecar_path() {
	local plan_path="$1"
	local base
	base=$(basename "${plan_path}" .md)
	local root="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
	printf '%s/.omca/notes/%s-completion.md' "${root}" "${base}"
}

# Check whether it is safe to overwrite an existing sidecar file.
# Returns 0 (safe) when: no existing file, no SHA field found, or SHA matches.
# Returns 1 (refuse) when an existing SHA differs from current_sha.
# Usage: check_sidecar_idempotency <sidecar_path> <current_sha>
check_sidecar_idempotency() {
	local sidecar_path="$1"
	local current_sha="$2"
	[[ -f "${sidecar_path}" ]] || return 0
	local existing_sha
	existing_sha=$(grep -E '^plan_sha256: *' "${sidecar_path}" | head -1 | awk '{print $2}' | tr -d '"' || echo "")
	[[ -z "${existing_sha}" ]] && return 0
	[[ "${existing_sha}" == "${current_sha}" ]] && return 0
	return 1
}

# Resolve the current Claude session ID from the environment or hook state.
# Prints the first non-empty, non-"null", non-"unknown" value found across:
#   1. $CLAUDE_SESSION_ID env var
#   2. .session_id field in $HOOK_INPUT JSON
#   3. .sessionId field in $HOOK_STATE_DIR/session.json
# Prints empty string and returns 0 when no valid ID is found.
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
	return 0  # empty stdout, success
}

# Check whether a sidecar file exists and contains a matching plan_sha256.
# Returns 0 (match) when: file exists AND plan_sha256: line value equals expected.
# Returns 1 (no match) when: file absent, no plan_sha256 line, or SHA differs.
# Usage: sidecar_sha_matches <sidecar_path> <expected_sha>
sidecar_sha_matches() {
	local path="$1" expected="$2" actual
	[[ -f "${path}" ]] || return 1
	actual=$(grep -m1 '^plan_sha256:' "${path}" 2>/dev/null | awk -F':' '{print $2}' | tr -d '[:space:]' || true)
	[[ -n "${actual}" && "${actual}" == "${expected}" ]]
}

# Read a single JSON field from a state file with a default value.
# Purpose: Unified jq file-read idiom — eliminates repeated `jq -r 'EXPR // DEFAULT' FILE` inline calls.
# Inputs:  $1 — path to the JSON file
#          $2 — jq expression including the `//` default (e.g. '.active_plan // ""')
# Outputs: stdout — the extracted string; prints default portion of $2 when file absent
# Exit:    always 0
# Error handling: if file is absent, jq is not invoked; returns empty string (or literal default
#   when the expression embeds one). If file is malformed, jq returns the default via `//`.
jq_read() {
	local file="$1"
	local expr="$2"
	if [[ ! -f "${file}" ]]; then
		# Evaluate default from the expression (extract the `// "VALUE"` part)
		jq -rn "${expr}" 2>/dev/null || true
		return 0
	fi
	jq -r "${expr}" "${file}" 2>/dev/null || true
}

# Emit a hookSpecificOutput JSON object after JSON-escaping the message.
# Purpose: Collapses the repeated two-step `ESCAPED=$(echo MSG | jq -Rs .) + echo JSON` idiom.
# Inputs:  $1 — hookEventName string (e.g. "PostToolUse", "UserPromptSubmit")
#          $2 — plain-text message (will be JSON-escaped via jq -Rs .)
# Outputs: stdout — one-line JSON: {"hookSpecificOutput":{"hookEventName":"...","additionalContext":"..."}}
# Exit:    always 0
# Error handling: if jq fails, escaped value is empty string; output is still valid JSON.
emit_context() {
	local event_name="$1"
	local message="$2"
	local escaped
	escaped=$(printf '%s\n' "${message}" | jq -Rs .)
	printf '{"hookSpecificOutput": {"hookEventName": "%s", "additionalContext": %s}}\n' \
		"${event_name}" "${escaped}"
}

# Append a hook timing entry to hook-timing.jsonl using a previously recorded start timestamp.
# Purpose: Collapses the repeated three-line _HOOK_END / _HOOK_MS / echo >> hook-timing.jsonl pattern.
# Inputs:  $1 — start nanosecond timestamp (from `date +%s%N 2>/dev/null || date +%s`)
# Outputs: appends one JSON line to ${HOOK_LOG_DIR}/hook-timing.jsonl
# Exit:    always 0
# Error handling: write failures are silently suppressed (2>/dev/null); non-deterministic
#   timing values are normalized by the golden-replay harness.
hook_timing_log() {
	local start_ns="$1"
	local end_ns ms
	end_ns=$(date +%s%N 2>/dev/null || date +%s)
	ms=$(( (end_ns - start_ns) / 1000000 ))
	echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"hook\":\"$(basename "$0")\",\"ms\":${ms}}" \
		>> "${HOOK_LOG_DIR}/hook-timing.jsonl" 2>/dev/null
}
