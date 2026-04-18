#!/bin/bash
# run-hook-in-scratch.sh — run a hook script in an isolated scratch directory.
# CLAUDE_PROJECT_ROOT is set to a fresh tmpdir (cleaned on exit) so hooks
# cannot mutate the real .omca/state/. Stdin and exit code propagate via exec.
# Usage: scripts/bin/run-hook-in-scratch.sh <hook-name-or-path> [args...]

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	cat <<'EOF'
Usage: run-hook-in-scratch.sh <hook-name-or-path> [args...]

Run a hook script in an isolated scratch directory so it cannot mutate the
real .omca/state/ of the current project.

Hook resolution order (first match wins):
  1. Path exists as given
  2. scripts/<name>
  3. scripts/lib/<name>

Stdin is forwarded to the hook; the hook's exit code is propagated.
The scratch tmpdir is removed automatically on exit.

Options:
  -h, --help    Print this help and exit
EOF
	exit 0
fi

if [[ $# -lt 1 ]]; then
	echo "run-hook-in-scratch.sh: error: hook name or path required" >&2
	echo "Usage: run-hook-in-scratch.sh <hook-name-or-path> [args...]" >&2
	exit 1
fi

HOOK_ARG="$1"
shift

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -f "${HOOK_ARG}" ]]; then
	HOOK_PATH="${HOOK_ARG}"
elif [[ -f "${PLUGIN_ROOT}/scripts/${HOOK_ARG}" ]]; then
	HOOK_PATH="${PLUGIN_ROOT}/scripts/${HOOK_ARG}"
elif [[ -f "${PLUGIN_ROOT}/scripts/lib/${HOOK_ARG}" ]]; then
	HOOK_PATH="${PLUGIN_ROOT}/scripts/lib/${HOOK_ARG}"
else
	echo "run-hook-in-scratch.sh: error: cannot find hook '${HOOK_ARG}'" >&2
	echo "  Tried: ${HOOK_ARG}" >&2
	echo "         ${PLUGIN_ROOT}/scripts/${HOOK_ARG}" >&2
	echo "         ${PLUGIN_ROOT}/scripts/lib/${HOOK_ARG}" >&2
	exit 1
fi

TMPDIR_SCRATCH="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_SCRATCH"' EXIT

echo "run-hook-in-scratch: scratch=${TMPDIR_SCRATCH}" >&2

export CLAUDE_PROJECT_ROOT="${TMPDIR_SCRATCH}"
mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/state"
mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/logs"
mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/rules"

bash "${HOOK_PATH}" "$@"
