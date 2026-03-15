#!/bin/bash
# MCP server launcher — referenced by .mcp.json, not hooks.json

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
if [[ "${SCRIPT_DIR}" = "${SCRIPT_PATH}" ]]; then
	SCRIPT_DIR="."
fi
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENV="${PLUGIN_ROOT}/.venv"
MARKER="${VENV}/.omca-installed"
EXPECTED_VERSION="2"
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

require_python() {
	if ! command -v python3 >/dev/null 2>&1; then
		die \
			"python3 is not installed or not in PATH." \
			"Install Python 3.10+ (including venv support), then rerun scripts/start-ast-grep-server.sh."
	fi

	local py_version
	py_version="$(python3 --version 2>&1 || true)"
	if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
		die \
			"Python 3.10+ is required, found: ${py_version}." \
			"Use Python 3.10+ and ensure 'python3' points to that interpreter."
	fi

	if ! python3 -m venv --help >/dev/null 2>&1; then
		die \
			"python3 is missing the venv module." \
			"Install your distro's venv package (for example: apt install python3-venv) and rerun."
	fi
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

needs_bootstrap=0
marker_content="$(cat "${MARKER}" 2>/dev/null || true)"
if [[ ! -f "${MARKER}" ]] || [[ "${marker_content}" != "${EXPECTED_VERSION}" ]]; then
	needs_bootstrap=1
fi
if [[ ! -x "${VENV}/bin/python3" ]]; then
	needs_bootstrap=1
fi

require_python
detect_ast_grep

if [[ ! -f "${SERVER_SCRIPT}" ]]; then
	die \
		"MCP server entrypoint missing at ${SERVER_SCRIPT}." \
		"Reinstall or restore the plugin files, then rerun."
fi

if [[ "${needs_bootstrap}" -eq 1 ]]; then
	log "Bootstrapping ast-grep MCP virtualenv at ${VENV}"
	rm -rf "${VENV}"

	if ! python3 -m venv "${VENV}" >&2; then
		rm -rf "${VENV}"
		die \
			"Failed to create virtualenv at ${VENV}." \
			"Install Python venv support and verify filesystem permissions, then rerun."
	fi

	if ! "${VENV}/bin/python3" -m pip install --disable-pip-version-check --no-input \
		'mcp[cli]>=1.6.0,<2.0' \
		'pydantic>=2.11,<3.0' \
		'pyyaml>=6.0,<7.0' \
		>&2; then
		rm -rf "${VENV}"
		die \
			"Python dependency bootstrap failed while installing MCP requirements." \
			"Check network/proxy/package index access, then rerun (the launcher cleaned the partial .venv)."
	fi

	if ! printf '%s\n' "${EXPECTED_VERSION}" >"${MARKER}"; then
		rm -rf "${VENV}"
		die \
			"Failed to write bootstrap marker at ${MARKER}." \
			"Check filesystem permissions and free disk space, then rerun."
	fi

	log "Virtualenv bootstrap complete."
fi

exec env AST_GREP_BIN="${AST_GREP_RESOLVED}" "${VENV}/bin/python3" "${SERVER_SCRIPT}"
