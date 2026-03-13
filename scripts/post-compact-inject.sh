#!/bin/bash

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
CONTEXT_FILE="${STATE_DIR}/compaction-context.md"
CLAIM_FILE="${STATE_DIR}/compaction-context.restore.$$"

if [[ ! -f "${CONTEXT_FILE}" ]]; then
	exit 0
fi

if ! mv "${CONTEXT_FILE}" "${CLAIM_FILE}" 2>/dev/null; then
	exit 0
fi

trap 'rm -f "${CLAIM_FILE}"' EXIT

CONTEXT=$(head -c 4000 "${CLAIM_FILE}" 2>/dev/null)

if [[ -z "${CONTEXT}" ]]; then
	exit 0
fi

ESCAPED=$(printf '[POST-COMPACTION CONTEXT RESTORE] %s' "${CONTEXT}" | jq -Rs .)
echo "{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": ${ESCAPED}}}"
