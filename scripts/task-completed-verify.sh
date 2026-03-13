#!/bin/bash

INPUT=$(cat)
BLOCK_EXIT_CODE=2
MAX_EVIDENCE_AGE_SECONDS=300

TASK_DESCRIPTION=$(echo "${INPUT}" | jq -r '.task_description // .description // ""' 2>/dev/null || echo "")

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
		exit "${BLOCK_EXIT_CODE}"
	fi

	if command -v stat &>/dev/null; then
		EVIDENCE_MTIME=$(stat -c %Y "${EVIDENCE_FILE}" 2>/dev/null || stat -f %m "${EVIDENCE_FILE}" 2>/dev/null || echo "")
		if [[ "${EVIDENCE_MTIME}" =~ ^[0-9]+$ ]]; then
			EVIDENCE_AGE=$(($(date +%s) - EVIDENCE_MTIME))
		else
			EVIDENCE_AGE=0
		fi
		if [[ "${EVIDENCE_AGE}" -gt "${MAX_EVIDENCE_AGE_SECONDS}" ]]; then
			echo "Verification evidence is stale (${EVIDENCE_AGE}s old). Run fresh verification before completing this task." >&2
			exit "${BLOCK_EXIT_CODE}"
		fi
	fi
fi

exit 0
