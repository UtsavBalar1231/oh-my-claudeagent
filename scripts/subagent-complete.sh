#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

SUBAGENT_ID=$(jq -r '.agent_id // ""' <<< "${HOOK_INPUT}")
# 500 bytes — last_assistant_message cap; enough for routing-audit without bloating log.
LAST_MSG=$(jq -r '.last_assistant_message // ""' <<< "${HOOK_INPUT}" | head -c 500)
# Derive outcome from last_assistant_message length (no exit_status field on SubagentStop).
# ≥50 chars → completed; 1-49 → stalled; 0 → empty.
MSG_LEN=${#LAST_MSG}
if [[ "${MSG_LEN}" -ge 50 ]]; then
	EXIT_STATUS="completed"
elif [[ "${MSG_LEN}" -ge 1 ]]; then
	EXIT_STATUS="stalled"
else
	EXIT_STATUS="empty"
fi

TIMESTAMP=$(date -Iseconds)
CURRENT_EPOCH=$(date +%s)
# 900s (15m) — subagent liveness TTL; the single authoritative "still running" rule,
# applied identically here, in active-agents.json, and in every reader. An entry whose
# started_epoch is older than this is a phantom (subagent died without a SubagentStop)
# and must not count as running. Entries with no started_epoch yet (pre-SubagentStart
# bridge, i.e. very recent spawn-* ids) are KEPT — never sweep an agent that just spawned.
CUTOFF=$(( CURRENT_EPOCH - 900 ))

SUBAGENTS_FILE="${STATE_DIR}/subagents.json"
if [[ -f "${SUBAGENTS_FILE}" ]]; then
	TMP_FILE=$(mktemp)
	jq --arg ts "${TIMESTAMP}" --arg status "${EXIT_STATUS}" --arg id "${SUBAGENT_ID}" --argjson cutoff "${CUTOFF}" \
		'.completed += [{"id": $id, "completedAt": $ts, "status": $status}] |
		 .active = [.active[] | select(.id != $id and ((.started_epoch == null) or (.started_epoch > $cutoff)))]' \
		"${SUBAGENTS_FILE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${SUBAGENTS_FILE}"
fi

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
	# flock-protected write to prevent concurrent deregistration races. CUTOFF (900s)
	# is defined once above and shared with the subagents.json sweep — one liveness rule.
	(
		# 5s — flock wait; long enough for concurrent siblings, short enough to fail fast.
		flock -w 5 200 || { log_hook_error "flock timeout on active-agents" "subagent-complete.sh"; exit 0; }
		TMP_ACTIVE=$(mktemp)
		jq --arg id "${SUBAGENT_ID}" --argjson cutoff "${CUTOFF}" \
			'[.[] | select(.id != $id and .started_epoch > $cutoff)]' \
			"${ACTIVE_FILE}" >"${TMP_ACTIVE}" && mv "${TMP_ACTIVE}" "${ACTIVE_FILE}"
	) 200>"${STATE_DIR}/active-agents.lock"
fi

METRICS_FILE="${LOG_DIR}/agent-metrics.jsonl"
RESOLVED_AGENT_TYPE="${AGENT_TYPE_FROM_ACTIVE:-$(jq -r '.agent_type // ""' <<< "${HOOK_INPUT}")}"
jq -nc --arg agent_type "${RESOLVED_AGENT_TYPE}" --arg agent_id "${SUBAGENT_ID}" \
	--argjson duration "${DURATION_SECONDS}" --arg status "${EXIT_STATUS}" --arg ts "${TIMESTAMP}" \
	'{agent_type: $agent_type, agent_id: $agent_id, duration_seconds: $duration, status: $status, timestamp: $ts}' \
	>>"${METRICS_FILE}"

AUDIT_FILE="${LOG_DIR}/routing-audit.jsonl"
# 200 bytes — routing-audit preview; smaller than 500-byte LAST_MSG cap for scannable log.
LAST_MSG_PREVIEW=$(printf '%s' "${LAST_MSG}" | head -c 200)
jq -nc --arg id "${SUBAGENT_ID}" --arg agent_type "$(jq -r '.agent_type // ""' <<< "${HOOK_INPUT}")" \
	--arg msg "${LAST_MSG_PREVIEW}" --arg ts "${TIMESTAMP}" \
	'{event: "agent_complete", id: $id, agent_type: $agent_type, message_preview: $msg, timestamp: $ts}' \
	>>"${AUDIT_FILE}"

LOG_FILE="${LOG_DIR}/subagents.jsonl"
jq -nc --arg id "${SUBAGENT_ID}" --arg status "${EXIT_STATUS}" --arg ts "${TIMESTAMP}" \
	'{event: "subagent_complete", id: $id, status: $status, timestamp: $ts}' >>"${LOG_FILE}"

TRANSCRIPT=$(jq -r '.agent_transcript_path // ""' <<< "${HOOK_INPUT}")
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

# Deliberately emits NO "agents still running, wait" barrier: it was age-blind (a
# phantom from a subagent that died without SubagentStop blocked forever) and the
# orchestrator must rely on the native Agent tool result, not a shell running-count.
exit 0
