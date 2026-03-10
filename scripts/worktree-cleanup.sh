#!/bin/bash

INPUT=$(cat)

WORKTREE_PATH=$(echo "${INPUT}" | jq -r '.worktree_path // ""' 2>/dev/null)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"
mkdir -p "${LOG_DIR}"

TIMESTAMP=$(date -Iseconds)

if [[ -n "${WORKTREE_PATH}" ]] && [[ -d "${WORKTREE_PATH}/.omca" ]]; then
	WORKTREE_NAME=$(basename "${WORKTREE_PATH}")
	ARCHIVE_FILE="${LOG_DIR}/worktree-archive-${WORKTREE_NAME}.log"

	{
		echo "=== Worktree Archive: ${WORKTREE_NAME} ==="
		echo "Removed at: ${TIMESTAMP}"
		echo "Path: ${WORKTREE_PATH}"
	} >>"${ARCHIVE_FILE}"

	if [[ -d "${WORKTREE_PATH}/.omca/state" ]]; then
		echo "State files:" >>"${ARCHIVE_FILE}"
		ls -la "${WORKTREE_PATH}/.omca/state/" >>"${ARCHIVE_FILE}" 2>/dev/null || true
	fi
fi

WORKTREES_DIR="${STATE_DIR}/worktrees"
if [[ -d "${WORKTREES_DIR}" ]]; then
	for TRACKING_FILE in "${WORKTREES_DIR}"/*.json; do
		if [[ -f "${TRACKING_FILE}" ]]; then
			TRACKED_PATH=$(jq -r '.path // ""' "${TRACKING_FILE}" 2>/dev/null)
			if [[ "${TRACKED_PATH}" == "${WORKTREE_PATH}" ]]; then
				rm -f "${TRACKING_FILE}"
			fi
		fi
	done
fi

jq -nc --arg path "${WORKTREE_PATH}" --arg ts "${TIMESTAMP}" \
	'{event: "worktree_removed", path: $path, timestamp: $ts}' >>"${LOG_DIR}/worktrees.jsonl"

exit 0
