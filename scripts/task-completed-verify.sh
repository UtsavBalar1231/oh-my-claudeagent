#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"
STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

BLOCK_EXIT_CODE=2
MAX_EVIDENCE_AGE_SECONDS=300

TASK_DESCRIPTION=$(echo "${INPUT}" | jq -r '.task_description // .description // ""' 2>/dev/null || echo "")

EVIDENCE_FILE="${STATE_DIR}/verification-evidence.json"

# Determine if recent evidence exists (within MAX_EVIDENCE_AGE_SECONDS)
RECENT_EVIDENCE=false
EVIDENCE_AGE=0
if [[ -f "${EVIDENCE_FILE}" ]]; then
	if command -v stat &>/dev/null; then
		EVIDENCE_MTIME=$(stat -c %Y "${EVIDENCE_FILE}" 2>/dev/null || stat -f %m "${EVIDENCE_FILE}" 2>/dev/null || echo "")
		if [[ "${EVIDENCE_MTIME}" =~ ^[0-9]+$ ]]; then
			EVIDENCE_AGE=$(($(date +%s) - EVIDENCE_MTIME))
			if [[ "${EVIDENCE_AGE}" -le "${MAX_EVIDENCE_AGE_SECONDS}" ]]; then
				RECENT_EVIDENCE=true
			fi
		else
			# Cannot determine mtime — treat as fresh
			RECENT_EVIDENCE=true
		fi
	else
		# No stat available — treat as fresh
		RECENT_EVIDENCE=true
	fi
fi

# Determine if recent edits exist (within MAX_EVIDENCE_AGE_SECONDS)
RECENT_EDITS=false
EDITS_LOG="${LOG_DIR}/edits.jsonl"
if [[ -f "${EDITS_LOG}" ]]; then
	if command -v stat &>/dev/null; then
		EDITS_MTIME=$(stat -c %Y "${EDITS_LOG}" 2>/dev/null || stat -f %m "${EDITS_LOG}" 2>/dev/null || echo "")
		if [[ "${EDITS_MTIME}" =~ ^[0-9]+$ ]]; then
			EDITS_AGE=$(($(date +%s) - EDITS_MTIME))
			if [[ "${EDITS_AGE}" -le "${MAX_EVIDENCE_AGE_SECONDS}" ]]; then
				RECENT_EDITS=true
			fi
		fi
	fi
fi

# Evidence-aware logic:
# 1. Recent evidence → ALLOW (already verified)
# 2. Recent edits but no recent evidence → BLOCK (files were modified without verification)
# 3. No recent edits and no recent evidence → ALLOW (informational task, nothing to verify)
if [[ "${RECENT_EVIDENCE}" == "true" ]]; then
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
		_log_hook_error "invalid evidence schema for task: ${TASK_DESCRIPTION:0:100}" "task-completed-verify.sh"
		echo "Verification evidence has invalid schema. Use the evidence_log MCP tool (NOT manual file writes). Required: entries[] with type, command, exit_code, output_snippet, timestamp fields." >&2
		exit "${BLOCK_EXIT_CODE}"
	fi
	# Valid recent evidence — allow
elif [[ "${RECENT_EDITS}" == "true" ]]; then
	# Files were modified but no verification was run
	_log_hook_error "edits without evidence for task: ${TASK_DESCRIPTION:0:100}" "task-completed-verify.sh"
	echo "Files were modified but no verification evidence was recorded. Use the evidence_log MCP tool after running build/test commands. Example: evidence_log(evidence_type=\"test\", command=\"just test\", exit_code=0, output_snippet=\"10 passed\")" >&2
	exit "${BLOCK_EXIT_CODE}"
fi
# else: no recent edits, no recent evidence → informational task, allow silently

exit 0
