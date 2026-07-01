#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

REASON=$(jq -r '.reason // "other"' <<< "${HOOK_INPUT}")

SESSION_STATE="${STATE_DIR}/session.json"
SESSION_ID="unknown"
if [[ -f "${SESSION_STATE}" ]]; then
	SESSION_ID=$(jq_read "${SESSION_STATE}" '.sessionId // "unknown"' "unknown")
fi

TIMESTAMP=$(date -Iseconds)

ERROR_COUNT=$(wc -l <"${LOG_DIR}/hook-errors.jsonl" 2>/dev/null || echo 0)

LOG_FILE="${LOG_DIR}/sessions.jsonl"
jq -nc --arg sid "${SESSION_ID}" --arg ts "${TIMESTAMP}" \
	--argjson err "${ERROR_COUNT}" \
	'{event: "session_end", sessionId: $sid, timestamp: $ts, hook_errors: $err}' >>"${LOG_FILE}"

if [[ "${REASON}" != "resume" ]]; then
	TEMP_FILES=(
		"${STATE_DIR}/session.json"
		"${STATE_DIR}/recent-edits.json"
		"${STATE_DIR}/injected-context-dirs.json"
		# Per-session delegate-error counters — reset by session-init.sh on next start.
		"${STATE_DIR}/error-counts.json"
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
				TRACKED_PATH=$(jq_read "${TRACKING_FILE}" '.worktreePath // .path // ""')
				if [[ -n "${TRACKED_PATH}" ]] && [[ ! -d "${TRACKED_PATH}" ]]; then
					rm -f "${TRACKING_FILE}"
				fi
			fi
		done
	fi

	find "${STATE_DIR}" -name "*.json" -mtime +1 \
		-not -name 'team-state.json' \
		-not -name 'boulder.json' \
		-not -name 'verification-evidence.json' \
		-delete 2>/dev/null || true

	find "${LOG_DIR}" -name "*.jsonl" -mtime +7 -delete 2>/dev/null || true

	# Authoritative binding GC: drop this session's boulder.json binding under the
	# same flock the MCP writer (boulder.py) uses. boulder_write's age-prune is
	# only a backstop for sessions that never hit SessionEnd cleanly.
	BOULDER_FILE_PATH="${STATE_DIR}/boulder.json"
	BOULDER_LOCK_PATH="${STATE_DIR}/boulder.json.lock"
	if [[ -n "${SESSION_ID}" ]] && [[ "${SESSION_ID}" != "unknown" ]] \
		&& [[ -f "${BOULDER_FILE_PATH}" ]] \
		&& command -v flock >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
		(
			flock -x 200
			BOULDER_TMP=$(mktemp)
			if jq --arg sid "${SESSION_ID}" \
				'if has("bindings") then .bindings |= del(.[$sid]) else . end' \
				"${BOULDER_FILE_PATH}" >"${BOULDER_TMP}" 2>/dev/null; then
				mv "${BOULDER_TMP}" "${BOULDER_FILE_PATH}"
			else
				rm -f "${BOULDER_TMP}"
			fi
		) 200>"${BOULDER_LOCK_PATH}"
	fi
fi

exit 0
