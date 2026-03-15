#!/bin/bash
# MCP server launcher — referenced by .mcp.json, not hooks.json

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
if [[ "${SCRIPT_DIR}" = "${SCRIPT_PATH}" ]]; then
	SCRIPT_DIR="."
fi
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVER_SCRIPT="${PLUGIN_ROOT}/servers/ast-grep-server.py"

log() {
	printf '[ast-grep-mcp] %s\n' "$1" >&2
}

die() {
	printf '[ast-grep-mcp] ERROR: %s\n' "$1" >&2
	if [[ -n "${2:-}" ]]; then
		printf '[ast-grep-mcp] Recovery: %s\n' "$2" >&2
	fi
	exit 1
}

resolve_binary() {
	local candidate="$1"
	if [[ "${candidate}" == */* ]]; then
		if [[ -x "${candidate}" ]]; then
			printf '%s\n' "${candidate}"
			return 0
		fi
		return 1
	fi

	command -v "${candidate}" 2>/dev/null
}

is_ast_grep_binary() {
	local candidate="$1"
	local resolved
	resolved="$(resolve_binary "${candidate}")" || return 1

	local version_out
	version_out="$("${resolved}" --version 2>/dev/null || true)"
	if [[ "${version_out,,}" == *"ast-grep"* ]]; then
		printf '%s\n' "${resolved}"
		return 0
	fi

	return 1
}

detect_ast_grep() {
	if [[ -n "${AST_GREP_BIN:-}" ]]; then
		if AST_GREP_RESOLVED="$(is_ast_grep_binary "${AST_GREP_BIN}")"; then
			return 0
		fi
		die \
			"AST_GREP_BIN='${AST_GREP_BIN}' is not executable ast-grep." \
			"Point AST_GREP_BIN to a valid ast-grep binary, or unset it and install ast-grep."
	fi

	local candidate
	for candidate in ast-grep sg; do
		if AST_GREP_RESOLVED="$(is_ast_grep_binary "${candidate}")"; then
			return 0
		fi
	done

	die \
		"ast-grep CLI is missing (looked for 'ast-grep' and 'sg')." \
		"Install ast-grep (cargo install ast-grep --locked | brew install ast-grep | npm install -g @ast-grep/cli) and rerun."
}

if ! command -v uv >/dev/null 2>&1; then
	die \
		"uv is not installed or not in PATH." \
		"Install uv (curl -LsSf https://astral.sh/uv/install.sh | sh) and rerun."
fi

detect_ast_grep

if [[ ! -f "${SERVER_SCRIPT}" ]]; then
	die \
		"MCP server entrypoint missing at ${SERVER_SCRIPT}." \
		"Reinstall or restore the plugin files, then rerun."
fi

exec env AST_GREP_BIN="${AST_GREP_RESOLVED}" uv run --project "${PLUGIN_ROOT}" python "${SERVER_SCRIPT}"
