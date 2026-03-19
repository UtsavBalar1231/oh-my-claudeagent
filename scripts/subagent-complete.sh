#!/bin/bash

INPUT=$(cat)

SUBAGENT_ID=$(echo "${INPUT}" | jq -r '.agent_id // ""' 2>/dev/null)
LAST_MSG=$(echo "${INPUT}" | jq -r '.last_assistant_message // ""' 2>/dev/null | head -c 500)
EXIT_STATUS="completed"  # SubagentStop only fires on completion; no exit_status field exists

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"

mkdir -p "${STATE_DIR}" "${LOG_DIR}"

TIMESTAMP=$(date -Iseconds)

SUBAGENTS_FILE="${STATE_DIR}/subagents.json"
if [[ -f "${SUBAGENTS_FILE}" ]]; then
	TMP_FILE=$(mktemp)
	jq --arg ts "${TIMESTAMP}" --arg status "${EXIT_STATUS}" --arg id "${SUBAGENT_ID}" \
		'.completed += [{"id": $id, "completedAt": $ts, "status": $status}] |
		 .active = [.active[] | select(.id != $id)]' \
		"${SUBAGENTS_FILE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${SUBAGENTS_FILE}"
fi

# --- Concurrency deregistration (atomic mktemp+mv) ---
ACTIVE_FILE="${STATE_DIR}/active-agents.json"
if [[ -f "${ACTIVE_FILE}" ]]; then
	TMP_ACTIVE=$(mktemp)
	CUTOFF=$(( $(date +%s) - 900 ))  # 15-min TTL
	jq --arg id "${SUBAGENT_ID}" --argjson cutoff "${CUTOFF}" \
		'[.[] | select(.id != $id and .started_epoch > $cutoff)]' \
		"${ACTIVE_FILE}" >"${TMP_ACTIVE}" && mv "${TMP_ACTIVE}" "${ACTIVE_FILE}"
fi

# --- Routing audit log ---
AUDIT_FILE="${LOG_DIR}/routing-audit.jsonl"
LAST_MSG_PREVIEW=$(echo "${LAST_MSG}" | head -c 200)
jq -nc --arg id "${SUBAGENT_ID}" --arg agent_type "$(echo "${INPUT}" | jq -r '.agent_type // ""')" \
	--arg msg "${LAST_MSG_PREVIEW}" --arg ts "${TIMESTAMP}" \
	'{event: "agent_complete", id: $id, agent_type: $agent_type, message_preview: $msg, timestamp: $ts}' \
	>>"${AUDIT_FILE}"

LOG_FILE="${LOG_DIR}/subagents.jsonl"
jq -nc --arg id "${SUBAGENT_ID}" --arg status "${EXIT_STATUS}" --arg ts "${TIMESTAMP}" \
	'{event: "subagent_complete", id: $id, status: $status, timestamp: $ts}' >>"${LOG_FILE}"

# Log subagent final message summary and transcript path for audit
TRANSCRIPT=$(echo "${INPUT}" | jq -r '.agent_transcript_path // ""' 2>/dev/null)
if [[ -n "${LAST_MSG}" ]]; then
	jq -nc --arg id "${SUBAGENT_ID}" --arg msg "${LAST_MSG}" --arg transcript "${TRANSCRIPT}" --arg ts "${TIMESTAMP}" \
		'{event: "subagent_summary", id: $id, last_message_preview: $msg, transcript_path: $transcript, timestamp: $ts}' >>"${LOG_FILE}"
fi

SESSION_STATE="${STATE_DIR}/session.json"
if [[ -f "${SESSION_STATE}" ]]; then
	TMP_FILE=$(mktemp)
	jq --arg status "${EXIT_STATUS}" --arg id "${SUBAGENT_ID}" '
    if (.subagents | length) > 0 then
      (.subagents | to_entries | map(select(.value.id == $id)) | last // null) as $match |
      if $match != null then
        .subagents[$match.key].status = $status
      else
        .
      end
    else
      .
    end
  ' "${SESSION_STATE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${SESSION_STATE}"
fi

exit 0
