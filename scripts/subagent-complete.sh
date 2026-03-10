#!/bin/bash

INPUT=$(cat)

SUBAGENT_ID=$(echo "${INPUT}" | jq -r '.subagent_id // ""' 2>/dev/null)
EXIT_STATUS=$(echo "${INPUT}" | jq -r '.exit_status // "completed"' 2>/dev/null)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"

mkdir -p "${STATE_DIR}" "${LOG_DIR}"

TIMESTAMP=$(date -Iseconds)

SUBAGENTS_FILE="${STATE_DIR}/subagents.json"
if [[ -f "${SUBAGENTS_FILE}" ]]; then
	TMP_FILE=$(mktemp)

	jq --arg ts "${TIMESTAMP}" --arg status "${EXIT_STATUS}" --arg id "${SUBAGENT_ID}" '
    (.active | to_entries | map(select(.value.id == $id)) | first // null) as $match |
    if $match != null then
      .completed += [($match.value + {"completedAt": $ts, "status": $status})] |
      .active = [.active[] | select(.id != $id)]
    else
      .completed += [{"id": $id, "completedAt": $ts, "status": $status}]
    end
  ' "${SUBAGENTS_FILE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${SUBAGENTS_FILE}"
fi

LOG_FILE="${LOG_DIR}/subagents.jsonl"
jq -nc --arg id "${SUBAGENT_ID}" --arg status "${EXIT_STATUS}" --arg ts "${TIMESTAMP}" \
	'{event: "subagent_complete", id: $id, status: $status, timestamp: $ts}' >>"${LOG_FILE}"

SESSION_STATE="${STATE_DIR}/session.json"
if [[ -f "${SESSION_STATE}" ]]; then
	TMP_FILE=$(mktemp)
	jq --arg status "${EXIT_STATUS}" --arg id "${SUBAGENT_ID}" '
    if (.subagents | length) > 0 then
      (.subagents | to_entries | map(select(.value.id == $id)) | last // null) as $match |
      if $match != null then
        .subagents[$match.key].status = $status
      else
        .subagents[-1].status = $status
      end
    else
      .
    end
  ' "${SESSION_STATE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${SESSION_STATE}"
fi

exit 0
