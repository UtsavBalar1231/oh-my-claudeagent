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

# Ensure state directories exist
mkdir -p "${HOOK_STATE_DIR}" "${HOOK_LOG_DIR}" 2>/dev/null

# Hook error logging helper
_log_hook_error() {
	local msg="$1"
	local hook_name="${2:-$(basename "$0")}"
	echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"hook\":\"${hook_name}\",\"error\":\"${msg}\"}" >> "${HOOK_LOG_DIR}/hook-errors.jsonl" 2>/dev/null
}
