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
_log_hook_error() {
	local msg="$1"
	local hook_name="${2:-$(basename "$0")}"
	echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"hook\":\"${hook_name}\",\"error\":\"${msg}\"}" >>"${HOOK_LOG_DIR}/hook-errors.jsonl" 2>/dev/null
}

# Generate a decorated section header for additionalContext blocks
_section_header() {
	local title="$1"
	printf '\n─── %s ─────────────────────────────────────\n' "${title}"
}

_mode_state_name() {
	local mode="$1"
	printf '%s%s' "${mode}" "${HOOK_MODE_STATE_SUFFIX}"
}

_mode_state_path() {
	local mode="$1"
	local state_dir="${2:-${HOOK_STATE_DIR}}"
	printf '%s/%s' "${state_dir}" "$(_mode_state_name "${mode}")"
}

_mode_is_active() {
	local mode="$1"
	local state_dir="${2:-${HOOK_STATE_DIR}}"
	local state_file
	local status

	state_file="$(_mode_state_path "${mode}" "${state_dir}")"
	if [[ ! -f "${state_file}" ]]; then
		return 1
	fi

	status=$(jq -r '.status // "inactive"' "${state_file}" 2>/dev/null || echo "")
	[[ "${status}" == "active" ]]
}

# Compute the absolute path of the completion sidecar for a given plan file.
# Usage: _compute_sidecar_path <plan_path>
# Prints: $CLAUDE_PROJECT_ROOT/.omca/notes/<plan-basename-without-.md>-completion.md
_compute_sidecar_path() {
	local plan_path="$1"
	local base
	base=$(basename "${plan_path}" .md)
	local root="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
	printf '%s/.omca/notes/%s-completion.md' "${root}" "${base}"
}

# Check whether it is safe to overwrite an existing sidecar file.
# Returns 0 (safe) when: no existing file, no SHA field found, or SHA matches.
# Returns 1 (refuse) when an existing SHA differs from current_sha.
# Usage: _check_sidecar_idempotency <sidecar_path> <current_sha>
_check_sidecar_idempotency() {
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
_resolve_session_id() {
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
# Usage: _sidecar_sha_matches <sidecar_path> <expected_sha>
_sidecar_sha_matches() {
	local path="$1" expected="$2" actual
	[[ -f "${path}" ]] || return 1
	actual=$(grep -m1 '^plan_sha256:' "${path}" 2>/dev/null | awk -F':' '{print $2}' | tr -d '[:space:]' || true)
	[[ -n "${actual}" && "${actual}" == "${expected}" ]]
}
