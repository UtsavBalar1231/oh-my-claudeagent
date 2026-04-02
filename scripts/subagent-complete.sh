#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"
STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

SUBAGENT_ID=$(echo "${INPUT}" | jq -r '.agent_id // ""' 2>/dev/null)
LAST_MSG=$(echo "${INPUT}" | jq -r '.last_assistant_message // ""' 2>/dev/null | head -c 500)
EXIT_STATUS="completed"  # SubagentStop only fires on completion; no exit_status field exists

TIMESTAMP=$(date -Iseconds)
CURRENT_EPOCH=$(date +%s)

SUBAGENTS_FILE="${STATE_DIR}/subagents.json"
if [[ -f "${SUBAGENTS_FILE}" ]]; then
	TMP_FILE=$(mktemp)
	jq --arg ts "${TIMESTAMP}" --arg status "${EXIT_STATUS}" --arg id "${SUBAGENT_ID}" \
		'.completed += [{"id": $id, "completedAt": $ts, "status": $status}] |
		 .active = [.active[] | select(.id != $id)]' \
		"${SUBAGENTS_FILE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${SUBAGENTS_FILE}"
fi

# --- Concurrency deregistration (flock-protected read-modify-write) ---
ACTIVE_FILE="${STATE_DIR}/active-agents.json"
DURATION_SECONDS=0
AGENT_TYPE_FROM_ACTIVE=""
if [[ -f "${ACTIVE_FILE}" ]]; then
	# Read values outside flock so variables survive in parent shell
	STARTED_EPOCH=$(jq -r --arg id "${SUBAGENT_ID}" '.[] | select(.id == $id) | .started_epoch // 0' "${ACTIVE_FILE}" 2>/dev/null | head -1)
	AGENT_TYPE_FROM_ACTIVE=$(jq -r --arg id "${SUBAGENT_ID}" '.[] | select(.id == $id) | .agent // ""' "${ACTIVE_FILE}" 2>/dev/null | head -1)
	if [[ "${STARTED_EPOCH}" =~ ^[0-9]+$ ]] && [[ "${STARTED_EPOCH}" -gt 0 ]]; then
		DURATION_SECONDS=$(( CURRENT_EPOCH - STARTED_EPOCH ))
	fi
	# flock-protected write to prevent concurrent deregistration races
	CUTOFF=$(( CURRENT_EPOCH - 900 ))  # 15-min TTL
	(
		flock -w 5 200 || { _log_hook_error "flock timeout on active-agents" "subagent-complete.sh"; }
		TMP_ACTIVE=$(mktemp)
		jq --arg id "${SUBAGENT_ID}" --argjson cutoff "${CUTOFF}" \
			'[.[] | select(.id != $id and .started_epoch > $cutoff)]' \
			"${ACTIVE_FILE}" >"${TMP_ACTIVE}" && mv "${TMP_ACTIVE}" "${ACTIVE_FILE}"
	) 200>"${STATE_DIR}/active-agents.lock"
fi

# --- Agent metrics log ---
METRICS_FILE="${LOG_DIR}/agent-metrics.jsonl"
RESOLVED_AGENT_TYPE="${AGENT_TYPE_FROM_ACTIVE:-$(echo "${INPUT}" | jq -r '.agent_type // ""')}"
jq -nc --arg agent_type "${RESOLVED_AGENT_TYPE}" --arg agent_id "${SUBAGENT_ID}" \
	--argjson duration "${DURATION_SECONDS}" --arg status "${EXIT_STATUS}" --arg ts "${TIMESTAMP}" \
	'{agent_type: $agent_type, agent_id: $agent_id, duration_seconds: $duration, status: $status, timestamp: $ts}' \
	>>"${METRICS_FILE}"

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

# --- Background Agent Barrier: inject remaining-agents context into parent session ---
# When other agents are still running, return additionalContext so the orchestrator
# knows to wait instead of acting on partial results.
REMAINING_ACTIVE=0
if [[ -f "${SUBAGENTS_FILE}" ]]; then
	REMAINING_ACTIVE=$(jq '[.active[]? | select(.status == "running")] | length' "${SUBAGENTS_FILE}" 2>/dev/null || echo "0")
fi

if [[ "${REMAINING_ACTIVE}" -gt 0 ]]; then
	REMAINING_NAMES=$(jq -r '[.active[]? | select(.status == "running") | .type] | join(", ")' "${SUBAGENTS_FILE}" 2>/dev/null || echo "unknown")
	jq -nc --arg ctx "[BACKGROUND AGENTS PENDING] ${REMAINING_ACTIVE} agent(s) still running: ${REMAINING_NAMES}. Do NOT proceed with implementation — END your response and wait for remaining agent notifications." \
		'{hookSpecificOutput: {hookEventName: "SubagentStop", additionalContext: $ctx}}'
fi

exit 0
