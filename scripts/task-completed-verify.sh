#!/bin/bash
# TaskCompleted gate. The payload carries only the task's identity (task_id,
# task_subject, optional task_description and teammate_name) — nothing about what the
# task did — so a name-derived guess at whether verification was owed could only ever
# demand evidence for a command nobody ran, which is pressure toward fabricating it.
# The decision therefore comes from causal ordering against the slot that
# verification-command-recorder.sh writes: a verification ran, so evidence must
# postdate it.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

# 2 — platform exit code blocking TaskCompleted; exit 0 allows, exit 2 blocks.
BLOCK_EXIT_CODE=2

hook_is_disabled "task-completed-verify" && exit 0

# The verdict derives from state, not from the payload, so an unreadable payload costs
# only the audit line below. Warn and allow, matching drift-guard's posture.
if [[ "${HOOK_INPUT_TIMED_OUT:-0}" -eq 1 ]]; then
	echo "[TASK COMPLETED VERIFY] stdin read timed out — skipping the audit line; the evidence check still runs from state." >&2
fi

# 3600s (1h) — matches final-verification-evidence.sh's window. A verification older
# than this belongs to earlier work, not to the task completing now.
MAX_SLOT_AGE_SECONDS=3600

# TASK_DESCRIPTION truncated to :0:100 at the log/error sites — keeps entries scannable.
TASK_DESCRIPTION=$(jq -r '.task_description // .description // ""' <<< "${HOOK_INPUT}")
TEAMMATE_NAME=$(jq -r '.teammate_name // ""' <<< "${HOOK_INPUT}")
TEAM_NAME=$(jq -r '.team_name // ""' <<< "${HOOK_INPUT}")

if [[ -n "${TEAMMATE_NAME}" ]] || [[ -n "${TEAM_NAME}" ]]; then
	echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"hook\":\"task-completed-verify.sh\",\"teammate_name\":\"${TEAMMATE_NAME}\",\"team_name\":\"${TEAM_NAME}\",\"task\":\"${TASK_DESCRIPTION:0:100}\"}" >>"${LOG_DIR}/task-verify-audit.jsonl" 2>/dev/null
fi

SLOT_FILE="${STATE_DIR}/last-verification-command.json"
[[ -f "${SLOT_FILE}" ]] || exit 0

IFS=$'\t' read -r SLOT_COMMAND SLOT_AT SLOT_SESSION < <(jq -r '[(.command // ""), (.at // 0), (.session_id // "")] | @tsv' "${SLOT_FILE}" 2>/dev/null)
[[ "${SLOT_AT}" =~ ^[0-9]+$ ]] || exit 0
[[ -n "${SLOT_COMMAND}" ]] || exit 0

CURRENT_SESSION=$(resolve_session_id)
[[ "${SLOT_SESSION}" == "${CURRENT_SESSION}" ]] || exit 0

(($(date +%s) - SLOT_AT <= MAX_SLOT_AGE_SECONDS)) || exit 0

EVIDENCE_FILE=$(resolve_evidence_file "${STATE_DIR}")
EVIDENCE_MTIME=0
if [[ -f "${EVIDENCE_FILE}" ]]; then
	EVIDENCE_MTIME=$(stat -c %Y "${EVIDENCE_FILE}" 2>/dev/null || stat -f %m "${EVIDENCE_FILE}" 2>/dev/null)
	[[ "${EVIDENCE_MTIME}" =~ ^[0-9]+$ ]] || EVIDENCE_MTIME=0
fi

if ((EVIDENCE_MTIME >= SLOT_AT)); then
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
		log_hook_error "invalid evidence schema for task: ${TASK_DESCRIPTION:0:100}" "task-completed-verify.sh"
		echo "Verification evidence has invalid schema. Use the evidence_log MCP tool (NOT manual file writes). Required: entries[] with type, command, exit_code, output_snippet, timestamp fields." >&2
		exit "${BLOCK_EXIT_CODE}"
	fi
	exit 0
fi

log_hook_error "verification ran with no evidence logged after it: ${SLOT_COMMAND}" "task-completed-verify.sh"
echo "You ran \`${SLOT_COMMAND}\` at $(date -d "@${SLOT_AT}" +%H:%M 2>/dev/null || date -r "${SLOT_AT}" +%H:%M 2>/dev/null) but logged no evidence after it. Log the real result with evidence_log, including a non-zero exit_code if it failed. Example: evidence_log(evidence_type=\"test\", command=\"${SLOT_COMMAND}\", exit_code=0, output_snippet=\"10 passed\")" >&2
exit "${BLOCK_EXIT_CODE}"
