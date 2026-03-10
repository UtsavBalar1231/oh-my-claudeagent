#!/bin/bash

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"

EVIDENCE_FILE="${STATE_DIR}/verification-evidence.json"
for MODE_FILE in ralph-state.json ultrawork-state.json; do
	if [[ -f "${STATE_DIR}/${MODE_FILE}" ]]; then
		STATUS=$(jq -r '.status // "inactive"' "${STATE_DIR}/${MODE_FILE}" 2>/dev/null)
		if [[ "${STATUS}" == "active" ]]; then
			echo "Persistence mode is active. Continue working." >&2
			exit 2
		fi
		if [[ "${STATUS}" != "inactive" ]] && [[ "${STATUS}" != "completed" ]] && [[ "${STATUS}" != "cancelled" ]]; then
			if [[ ! -f "${EVIDENCE_FILE}" ]]; then
				echo "Verification required before going idle." >&2
				exit 2
			fi
		fi
	fi
done

exit 0
