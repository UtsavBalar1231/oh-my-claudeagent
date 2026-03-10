#!/bin/bash

INPUT=$(cat)

WORKTREE_NAME=$(echo "${INPUT}" | jq -r '.name // ""' 2>/dev/null)
WORKTREE_PATH=$(echo "${INPUT}" | jq -r '.worktree_path // ""' 2>/dev/null)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
WORKTREES_DIR="${STATE_DIR}/worktrees"
mkdir -p "${WORKTREES_DIR}"

TIMESTAMP=$(date -Iseconds)

if [[ -n "${WORKTREE_NAME}" ]]; then
	TMP_FILE=$(mktemp)
	jq -n \
		--arg name "${WORKTREE_NAME}" \
		--arg path "${WORKTREE_PATH}" \
		--arg ts "${TIMESTAMP}" \
		--arg sid "${CLAUDE_SESSION_ID:-unknown}" \
		'{name: $name, path: $path, createdAt: $ts, sessionId: $sid}' \
		>"${TMP_FILE}" && mv "${TMP_FILE}" "${WORKTREES_DIR}/${WORKTREE_NAME}.json"
fi

if [[ -n "${WORKTREE_PATH}" ]] && [[ -d "${WORKTREE_PATH}" ]]; then
	WORKTREE_OMCA="${WORKTREE_PATH}/.omca/state"
	mkdir -p "${WORKTREE_OMCA}"

	for STATE_FILE in ralph-state.json autopilot-state.json ultrawork-state.json team-state.json; do
		if [[ -f "${STATE_DIR}/${STATE_FILE}" ]]; then
			cp "${STATE_DIR}/${STATE_FILE}" "${WORKTREE_OMCA}/" 2>/dev/null || true
		fi
	done

	if [[ -f "${PROJECT_ROOT}/.omca/project-memory.json" ]]; then
		mkdir -p "${WORKTREE_PATH}/.omca"
		cp "${PROJECT_ROOT}/.omca/project-memory.json" "${WORKTREE_PATH}/.omca/" 2>/dev/null || true
	fi
fi

echo "${WORKTREE_PATH}"
