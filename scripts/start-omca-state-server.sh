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

require_python() {
	if ! command -v python3 >/dev/null 2>&1; then
		die \
			"python3 is not installed or not in PATH." \
			"Install Python 3.10+ (including venv support), then rerun."
	fi

	if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
		die \
			"Python 3.10+ is required." \
			"Use Python 3.10+ and ensure 'python3' points to that interpreter."
	fi

	if ! python3 -m venv --help >/dev/null 2>&1; then
		die \
			"python3 is missing the venv module." \
			"Install your distro's venv package (for example: apt install python3-venv) and rerun."
	fi
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

if [[ ! -f "${SERVER_SCRIPT}" ]]; then
	die \
		"MCP server entrypoint missing at ${SERVER_SCRIPT}." \
		"Reinstall or restore the plugin files, then rerun."
fi

if [[ "${needs_bootstrap}" -eq 1 ]]; then
	log "Bootstrapping omca-state MCP virtualenv at ${VENV}"
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

exec "${VENV}/bin/python3" "${SERVER_SCRIPT}"
