#!/bin/bash
# plan-checkbox-verify.sh — blocks Write to plan files missing - [ ] N. checkboxes.
# Outputs `{}` (empty JSON, no decision) on no-op exit-0 paths so the validate-plugin
# json-required check passes; only writes stderr + exits 2 on actual blocking case.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

# No-op exit helper: emit empty JSON object so PreToolUse json-required validators pass.
noop_exit() {
	printf '{}\n'
	exit 0
}

TOOL_NAME=$(jq -r '.tool_name // ""' <<< "${HOOK_INPUT}")

if [[ "${TOOL_NAME}" != "Write" ]]; then
	noop_exit
fi

FILE_PATH=$(jq -r '.tool_input.file_path // ""' <<< "${HOOK_INPUT}")

case "${FILE_PATH}" in
*/plans/*.md) ;;
*)
	noop_exit
	;;
esac

CONTENT=$(jq -r '.tool_input.content // ""' <<< "${HOOK_INPUT}")

BASENAME=$(basename "${FILE_PATH}")
IS_PLAN=false

if echo "${CONTENT}" | grep -q "^## TODOs"; then
	IS_PLAN=true
elif echo "${CONTENT}" | grep -q "^## Work Objectives"; then
	IS_PLAN=true
else
	case "${BASENAME}" in
	*-agent-*.md)
		IS_PLAN=true
		;;
	*) ;;
	esac
fi

if [[ "${IS_PLAN}" != "true" ]]; then
	noop_exit
fi

CHECKBOX_COUNT=$(printf '%s' "${CONTENT}" | grep -cE '^- \[ ?\] [0-9]+\.' 2>/dev/null || true)
CHECKBOX_COUNT="${CHECKBOX_COUNT:-0}"

if [[ "${CHECKBOX_COUNT}" -eq 0 ]]; then
	echo "[PLAN-CHECKBOX-VERIFY] Plan file ${FILE_PATH} has no - [ ] N. checkboxes. Prometheus must emit at least one numbered task. This is the load-bearing enforcement of orchestration discipline." >&2
	exit 2
fi

noop_exit
