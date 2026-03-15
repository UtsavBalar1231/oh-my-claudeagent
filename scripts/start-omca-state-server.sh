#!/bin/bash
# MCP server launcher — referenced by .mcp.json, not hooks.json

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
if [[ "${SCRIPT_DIR}" = "${SCRIPT_PATH}" ]]; then
	SCRIPT_DIR="."
fi
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVER_SCRIPT="${PLUGIN_ROOT}/servers/omca-state-server.py"

log() {
	printf '[omca-state-mcp] %s\n' "$1" >&2
}

die() {
	printf '[omca-state-mcp] ERROR: %s\n' "$1" >&2
	if [[ -n "${2:-}" ]]; then
		printf '[omca-state-mcp] Recovery: %s\n' "$2" >&2
	fi
	exit 1
}

if ! command -v uv >/dev/null 2>&1; then
	die \
		"uv is not installed or not in PATH." \
		"Install uv (curl -LsSf https://astral.sh/uv/install.sh | sh) and rerun."
fi

if [[ ! -f "${SERVER_SCRIPT}" ]]; then
	die \
		"MCP server entrypoint missing at ${SERVER_SCRIPT}." \
		"Reinstall or restore the plugin files, then rerun."
fi

exec uv run --project "${PLUGIN_ROOT}" python "${SERVER_SCRIPT}"
