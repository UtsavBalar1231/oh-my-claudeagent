#!/bin/bash

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
CONTEXT_FILE="${STATE_DIR}/compaction-context.md"

if [[ ! -f "${CONTEXT_FILE}" ]]; then
	exit 0
fi

CONTEXT=$(cat "${CONTEXT_FILE}" | head -c 4000)

if [[ -z "${CONTEXT}" ]]; then
	exit 0
fi

ESCAPED=$(echo "[POST-COMPACTION CONTEXT RESTORE] ${CONTEXT}" | jq -Rs .)
echo "{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": ${ESCAPED}}}"

rm -f "${CONTEXT_FILE}"
