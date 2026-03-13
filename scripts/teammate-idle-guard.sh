#!/bin/bash

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
BLOCK_EXIT_CODE=2

for MODE_FILE in ralph-state.json ultrawork-state.json; do
	if [[ -f "${STATE_DIR}/${MODE_FILE}" ]]; then
		STATUS=$(jq -r '.status // "inactive"' "${STATE_DIR}/${MODE_FILE}" 2>/dev/null || echo "")
		if [[ -z "${STATUS}" ]]; then
			continue
		fi
		if [[ "${STATUS}" == "active" ]]; then
			echo "Persistence mode is active. Continue working." >&2
			exit "${BLOCK_EXIT_CODE}"
		fi
	fi
done

exit 0
