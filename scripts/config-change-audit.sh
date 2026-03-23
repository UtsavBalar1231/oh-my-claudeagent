#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"
LOG_DIR="${HOOK_LOG_DIR}"

SOURCE=$(echo "${INPUT}" | jq -r '.source // ""' 2>/dev/null)
FILE_PATH=$(echo "${INPUT}" | jq -r '.file_path // ""' 2>/dev/null)

TIMESTAMP=$(date -Iseconds)

jq -nc --arg src "${SOURCE}" --arg file "${FILE_PATH}" --arg ts "${TIMESTAMP}" \
	'{event: "config_change", source: $src, file: $file, timestamp: $ts}' >>"${LOG_DIR}/config-changes.log"

exit 0
