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
