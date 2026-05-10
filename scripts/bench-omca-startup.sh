#!/bin/bash
# bench-omca-startup.sh — cold-start (rm .venv) and warm-start timing for the omca MCP server.

set -uo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# OMCA plugin data dir — always use the omca-specific path regardless of CLAUDE_PLUGIN_DATA,
# which may point to a different plugin when this script runs outside the omca plugin context.
PLUGIN_DATA="${HOME}/.claude/plugins/data/oh-my-claudeagent-omca"

SERVERS_DIR="${PLUGIN_ROOT}/servers"

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
	elapsed=$(awk "BEGIN { printf \"%.3f\", ($end - $start) / 1000000000 }")
	echo "${elapsed}"
	return "${rc}"
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

echo ""
echo "--- Results ---"
echo "cold=${COLD}"
echo "warm=${WARM}"

# --- Decision ---
# Threshold: warm < 2s AND cold < 4s → safe to adopt alwaysLoad: true
COLD_THRESHOLD=4
WARM_THRESHOLD=2

COLD_OK=$(awk "BEGIN { print (${COLD} < ${COLD_THRESHOLD}) ? \"yes\" : \"no\" }")
WARM_OK=$(awk "BEGIN { print (${WARM} < ${WARM_THRESHOLD}) ? \"yes\" : \"no\" }")

echo ""
echo "--- Decision ---"
echo "cold < ${COLD_THRESHOLD}s : ${COLD_OK}"
echo "warm < ${WARM_THRESHOLD}s : ${WARM_OK}"

if [[ "${COLD_OK}" == "yes" && "${WARM_OK}" == "yes" ]]; then
	echo "DECISION: adopt  (both thresholds passed — add alwaysLoad: true)"
else
	echo "DECISION: defer  (threshold exceeded — warmup needed before adopting)"
fi
