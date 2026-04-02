#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"
STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

BLOCK_EXIT_CODE=2
MAX_EVIDENCE_AGE_SECONDS=300

TASK_DESCRIPTION=$(echo "${INPUT}" | jq -r '.task_description // .description // ""' 2>/dev/null || echo "")
TEAMMATE_NAME=$(echo "${INPUT}" | jq -r '.teammate_name // ""' 2>/dev/null || echo "")
TEAM_NAME=$(echo "${INPUT}" | jq -r '.team_name // ""' 2>/dev/null || echo "")

# Log agent identity for audit trail when present
if [[ -n "${TEAMMATE_NAME}" ]] || [[ -n "${TEAM_NAME}" ]]; then
	echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"hook\":\"task-completed-verify.sh\",\"teammate_name\":\"${TEAMMATE_NAME}\",\"team_name\":\"${TEAM_NAME}\",\"task\":\"${TASK_DESCRIPTION:0:100}\"}" >>"${LOG_DIR}/task-verify-audit.jsonl" 2>/dev/null
fi

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

# Only require evidence for tasks involving code/runtime changes
NEEDS_EVIDENCE=false
if [[ "${TASK_DESCRIPTION}" =~ (verify|test|build|typecheck|lint|validate|fix|implement|refactor|deploy) ]]; then
	NEEDS_EVIDENCE=true
fi

# Explore/librarian agents perform research only — no build evidence required
if [[ "${TEAMMATE_NAME}" == "explore" || "${TEAMMATE_NAME}" == "librarian" ]]; then
	NEEDS_EVIDENCE=false
fi

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
elif [[ "${NEEDS_EVIDENCE}" == "true" ]]; then
	_log_hook_error "missing verification evidence for task: ${TASK_DESCRIPTION:0:100}" "task-completed-verify.sh"
	if [[ "${RECENT_EDITS}" == "true" ]]; then
		echo "Files were modified but no verification evidence was recorded. Use the evidence_log MCP tool after running build/test commands. Example: evidence_log(evidence_type=\"test\", command=\"just test\", exit_code=0, output_snippet=\"10 passed\")" >&2
	else
		echo "Task completion requires verification evidence, but no recent verification evidence was recorded. Use the evidence_log MCP tool after running the relevant build/test/lint command. Example: evidence_log(evidence_type=\"test\", command=\"just test\", exit_code=0, output_snippet=\"10 passed\")" >&2
	fi
	exit "${BLOCK_EXIT_CODE}"
fi

exit 0
