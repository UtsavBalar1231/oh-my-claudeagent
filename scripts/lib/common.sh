#!/usr/bin/env bash
# Shared hook boilerplate — sourced by all hook scripts
# Usage: source "$(dirname "$0")/lib/common.sh"
# For scripts in scripts/lib/ subdir: source "$(dirname "$0")/../lib/common.sh"

# Read hook payload from stdin (exported so sourcing scripts can use it)
HOOK_INPUT=$(cat)
export HOOK_INPUT

# Project and state paths
HOOK_PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
HOOK_STATE_DIR="${HOOK_PROJECT_ROOT}/.omca/state"
HOOK_LOG_DIR="${HOOK_PROJECT_ROOT}/.omca/logs"
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
