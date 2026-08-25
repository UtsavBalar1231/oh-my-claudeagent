#!/bin/bash
# bench-omca-startup.sh — startup timing AND tools/list payload size for the omca MCP server.
#
# Latency is paid once per session, bounded by the platform's 5s cap. The serialized tools/list
# payload is paid by every eager tool in every session's cached prefix, and any tool change
# invalidates that cache. Eager loading is decided on payload size; latency only rules out a
# pathologically slow server.

set -uo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# OMCA plugin data dir — always use the omca-specific path regardless of CLAUDE_PLUGIN_DATA,
# which may point to a different plugin when this script runs outside the omca plugin context.
PLUGIN_DATA="${HOME}/.claude/plugins/data/oh-my-claudeagent-omca"

SERVERS_DIR="${PLUGIN_ROOT}/servers"

# 60s — 4x the 15s warm deadline that servers/tests/test_startup_time.py applies to the same
# handshake. Runs after the warm-start pass below, so the venv is already primed.
TOOLS_LIST_DEADLINE_SECONDS=60

if [[ ! -f "${SERVERS_DIR}/pyproject.toml" ]]; then
	echo "ERROR: servers/pyproject.toml not found under PLUGIN_ROOT=${PLUGIN_ROOT}" >&2
	exit 1
fi

# Run the import under timed measurement; return elapsed seconds as float
run_timed() {
	local start end elapsed
	start=$(date +%s%N)
	UV_PROJECT_ENVIRONMENT="${PLUGIN_DATA}/.venv" \
		uv run --project "${SERVERS_DIR}" python -c "import omca; print('ok')" >/dev/null 2>&1
	local rc=$?
	end=$(date +%s%N)
	# nanoseconds → seconds with 3 decimal places
	elapsed=$(awk "BEGIN { printf \"%.3f\", (${end} - ${start}) / 1000000000 }")
	echo "${elapsed}"
	return "${rc}"
}

# Serialize a full tools/list response and report the character cost of the whole roster and of
# the subset carrying per-tool `anthropic/alwaysLoad`. Writes "<roster_chars> <eager_chars>".
measure_tools_list() {
	local resp
	resp=$(printf '%s\n' \
		'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"bench","version":"1"}}}' \
		'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
		'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' |
		UV_PROJECT_ENVIRONMENT="${PLUGIN_DATA}/.venv" \
			timeout "${TOOLS_LIST_DEADLINE_SECONDS}" \
			uv run --project "${SERVERS_DIR}" "${SERVERS_DIR}/omca-mcp.py" 2>/dev/null |
		grep '"id":2')

	if [[ -z "${resp}" ]]; then
		echo "0 0"
		return 1
	fi

	local roster eager
	roster=$(jq -r '.result.tools | tojson | length' <<<"${resp}")
	eager=$(jq -r '[.result.tools[] | select(._meta["anthropic/alwaysLoad"] == true)] | tojson | length' <<<"${resp}")
	echo "${roster} ${eager}"
}

echo "=== omca MCP startup bench ==="
echo "PLUGIN_ROOT : ${PLUGIN_ROOT}"
echo "PLUGIN_DATA : ${PLUGIN_DATA}"
echo ""

# --- Cold-start ---
echo "Running cold-start (removing .venv) ..."
rm -rf "${PLUGIN_DATA}/.venv"
COLD=$(run_timed)
echo "  cold-start : ${COLD}s"

# --- Warm-start ---
echo "Running warm-start ..."
WARM=$(run_timed)
echo "  warm-start : ${WARM}s"

echo "Measuring tools/list payload ..."
read -r ROSTER_CHARS EAGER_CHARS < <(measure_tools_list)
if [[ "${ROSTER_CHARS}" == "0" ]]; then
	echo "  tools/list : UNAVAILABLE (no response within ${TOOLS_LIST_DEADLINE_SECONDS}s)" >&2
else
	echo "  roster tools/list : ${ROSTER_CHARS} chars"
	echo "  eager subset      : ${EAGER_CHARS} chars"
fi

echo ""
echo "--- Results ---"
echo "cold=${COLD}"
echo "warm=${WARM}"
echo "tools_list_chars=${ROSTER_CHARS}"
echo "always_load_chars=${EAGER_CHARS}"

# Latency thresholds only establish that the server is not pathologically slow to start. They
# say nothing about whether a tool should load eagerly, which is a context-token question.
COLD_THRESHOLD=4
WARM_THRESHOLD=2

COLD_OK=$(awk "BEGIN { print (${COLD} < ${COLD_THRESHOLD}) ? \"yes\" : \"no\" }")
WARM_OK=$(awk "BEGIN { print (${WARM} < ${WARM_THRESHOLD}) ? \"yes\" : \"no\" }")

echo ""
echo "--- Decision ---"
echo "cold < ${COLD_THRESHOLD}s : ${COLD_OK}"
echo "warm < ${WARM_THRESHOLD}s : ${WARM_OK}"

if [[ "${COLD_OK}" == "yes" && "${WARM_OK}" == "yes" ]]; then
	echo "STARTUP: acceptable  (both thresholds passed)"
else
	echo "STARTUP: slow  (threshold exceeded; warmup needed)"
fi

echo ""
echo "Eager loading is governed by per-tool \`anthropic/alwaysLoad\` in servers/tools/, not by a"
echo "server-wide flag, and it is decided on payload size rather than on the timings above."
if [[ "${ROSTER_CHARS}" != "0" ]]; then
	echo "${EAGER_CHARS} of ${ROSTER_CHARS} chars currently load into every session's cached prefix;"
	echo "the rest reach the model through ToolSearch. Adding a tool to the eager set spends its"
	echo "share of the roster payload in every session, and changing any eager tool's schema"
	echo "invalidates the cached prefix. Weigh a candidate against those chars."
fi
