#!/bin/bash

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"

SESSION_STATE="${STATE_DIR}/session.json"
SESSION_ID="unknown"
if [[ -f "${SESSION_STATE}" ]]; then
	SESSION_ID=$(jq -r '.sessionId // "unknown"' "${SESSION_STATE}" 2>/dev/null)
fi

TIMESTAMP=$(date -Iseconds)

mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/sessions.jsonl"
jq -nc --arg sid "${SESSION_ID}" --arg ts "${TIMESTAMP}" \
	'{event: "session_end", sessionId: $sid, timestamp: $ts}' >>"${LOG_FILE}"

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
			TRACKED_PATH=$(jq -r '.path // ""' "${TRACKING_FILE}" 2>/dev/null)
			if [[ -n "${TRACKED_PATH}" ]] && [[ ! -d "${TRACKED_PATH}" ]]; then
				rm -f "${TRACKING_FILE}"
			fi
		fi
	done
fi

find "${STATE_DIR}" -name "*.json" -mtime +1 \
	-not -name 'ralph-state.json' \
	-not -name 'team-state.json' \
	-not -name 'boulder.json' \
	-not -name 'ultrawork-state.json' \
	-not -name 'autopilot-state.json' \
	-delete 2>/dev/null || true

find "${LOG_DIR}" -name "*.jsonl" -mtime +7 -delete 2>/dev/null || true

exit 0
