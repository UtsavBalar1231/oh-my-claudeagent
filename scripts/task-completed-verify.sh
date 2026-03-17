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
		echo "Task requires verification evidence. Use the evidence_record MCP tool (NOT manual file writes). Example: evidence_record(evidence_type=\"test\", command=\"just test\", exit_code=0, output_snippet=\"10 passed\")" >&2
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

	# Schema validation — reject manually-written files
	if ! jq -e '
	  .entries
	  | if type != "array" then error else . end
	  | if length == 0 then error else . end
	  | map(
	      .type and .command and (.exit_code != null) and .output_snippet and .timestamp
	    )
	  | all
	' "${EVIDENCE_FILE}" >/dev/null 2>&1; then
		echo "Verification evidence has invalid schema. Use the evidence_record MCP tool (NOT manual file writes). Required: entries[] with type, command, exit_code, output_snippet, timestamp fields." >&2
		exit "${BLOCK_EXIT_CODE}"
	fi
fi

exit 0
