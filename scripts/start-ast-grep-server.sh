#!/bin/bash
# Launcher for ast-grep MCP server with auto-bootstrapped venv.
# All bootstrap output goes to stderr — stdout is the MCP stdio transport.

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${PLUGIN_ROOT}/.venv"
MARKER="${VENV}/.omca-installed"
EXPECTED_VERSION="1"

# Check Python version (FastMCP requires 3.10+)
if ! python3 -c "import sys; assert sys.version_info >= (3, 10), f'Python 3.10+ required, got {sys.version}'" 2>/dev/null; then
	echo "ERROR: Python 3.10+ is required for the ast-grep MCP server." >&2
	echo "Current: $(python3 --version 2>&1)" >&2
	exit 1
fi

# Bootstrap venv if marker missing or version mismatch
if [ ! -f "${MARKER}" ] || [ "$(cat "${MARKER}" 2>/dev/null)" != "${EXPECTED_VERSION}" ]; then
	echo "Bootstrapping ast-grep MCP server venv..." >&2
	rm -rf "${VENV}"
	python3 -m venv "${VENV}" 2>&1 >&2
	"${VENV}/bin/pip" install --quiet \
		'mcp[cli]>=1.6.0,<2.0' \
		'pydantic>=2.11,<3.0' \
		'pyyaml>=6.0,<7.0' \
		2>&1 >&2
	echo "${EXPECTED_VERSION}" >"${MARKER}"
	echo "Venv ready." >&2
fi

exec "${VENV}/bin/python3" "${PLUGIN_ROOT}/servers/ast-grep-server.py"
