#!/bin/bash

INPUT=$(cat)

TASK_DESCRIPTION=$(echo "${INPUT}" | jq -r '.task_description // .description // ""' 2>/dev/null)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
EVIDENCE_FILE="${STATE_DIR}/verification-evidence.json"

NEEDS_VERIFICATION=false
if echo "${TASK_DESCRIPTION}" | grep -qiE '(verify|test|build|typecheck|lint|validate|fix|implement|refactor)'; then
	NEEDS_VERIFICATION=true
fi

if [[ "${NEEDS_VERIFICATION}" == "true" ]]; then
	if [[ ! -f "${EVIDENCE_FILE}" ]]; then
		echo "Task requires verification evidence before completion. Run tests/build and record results in .omca/state/verification-evidence.json" >&2
		exit 2
	fi

	if command -v stat &>/dev/null; then
		EVIDENCE_AGE=$(($(date +%s) - $(stat -c %Y "${EVIDENCE_FILE}" 2>/dev/null || stat -f %m "${EVIDENCE_FILE}" 2>/dev/null || echo "0")))
		if [[ "${EVIDENCE_AGE}" -gt 300 ]]; then
			echo "Verification evidence is stale (${EVIDENCE_AGE}s old). Run fresh verification before completing this task." >&2
			exit 2
		fi
	fi
fi

exit 0
