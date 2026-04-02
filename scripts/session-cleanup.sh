#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"
STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

REASON=$(echo "${INPUT}" | jq -r '.reason // "other"' 2>/dev/null)

SESSION_STATE="${STATE_DIR}/session.json"
SESSION_ID="unknown"
if [[ -f "${SESSION_STATE}" ]]; then
	SESSION_ID=$(jq -r '.sessionId // "unknown"' "${SESSION_STATE}" 2>/dev/null)
fi

TIMESTAMP=$(date -Iseconds)

ERROR_COUNT=$(wc -l <"${LOG_DIR}/hook-errors.jsonl" 2>/dev/null || echo 0)
AGENT_COUNT=$(wc -l <"${LOG_DIR}/subagents.jsonl" 2>/dev/null || echo 0)

LOG_FILE="${LOG_DIR}/sessions.jsonl"
jq -nc --arg sid "${SESSION_ID}" --arg ts "${TIMESTAMP}" \
	--argjson err "${ERROR_COUNT}" --argjson agents "${AGENT_COUNT}" \
	'{event: "session_end", sessionId: $sid, timestamp: $ts, hook_errors: $err, agents_spawned: $agents}' >>"${LOG_FILE}"

if [[ "${REASON}" != "resume" ]]; then
	TEMP_FILES=(
		"${STATE_DIR}/session.json"
		"${STATE_DIR}/subagents.json"
		"${STATE_DIR}/recent-edits.json"
		"${STATE_DIR}/injected-context-dirs.json"
		"${STATE_DIR}/agent-usage.json"
	)

	for file in "${TEMP_FILES[@]}"; do
		if [[ -f "${file}" ]]; then
			rm -f "${file}"
		fi
	done

	WORKTREES_DIR="${STATE_DIR}/worktrees"
	if [[ -d "${WORKTREES_DIR}" ]]; then
		for TRACKING_FILE in "${WORKTREES_DIR}"/*.json; do
			if [[ -f "${TRACKING_FILE}" ]]; then
				TRACKED_PATH=$(jq -r '.worktreePath // .path // ""' "${TRACKING_FILE}" 2>/dev/null)
				if [[ -n "${TRACKED_PATH}" ]] && [[ ! -d "${TRACKED_PATH}" ]]; then
					rm -f "${TRACKING_FILE}"
				fi
			fi
		done
	fi

	find "${STATE_DIR}" -name "*.json" -mtime +1 \
		-not -name "$(_mode_state_name "ralph")" \
		-not -name 'team-state.json' \
		-not -name 'boulder.json' \
		-not -name "$(_mode_state_name "ultrawork")" \
		-not -name 'verification-evidence.json' \
		-delete 2>/dev/null || true

	find "${LOG_DIR}" -name "*.jsonl" -mtime +7 -delete 2>/dev/null || true
fi

exit 0
