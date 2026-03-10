#!/bin/bash

INPUT=$(cat)

SOURCE=$(echo "${INPUT}" | jq -r '.source // ""' 2>/dev/null)
FILE_PATH=$(echo "${INPUT}" | jq -r '.file_path // ""' 2>/dev/null)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"
mkdir -p "${LOG_DIR}"

TIMESTAMP=$(date -Iseconds)

jq -nc --arg src "${SOURCE}" --arg file "${FILE_PATH}" --arg ts "${TIMESTAMP}" \
	'{event: "config_change", source: $src, file: $file, timestamp: $ts}' >>"${LOG_DIR}/config-changes.log"

if [[ "${SOURCE}" == "policy_settings" ]]; then
	exit 0
fi

exit 0
