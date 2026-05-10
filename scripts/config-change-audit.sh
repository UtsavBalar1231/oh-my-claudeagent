#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

LOG_DIR="${HOOK_LOG_DIR}"

SOURCE=$(jq -r '.source // ""' <<< "${HOOK_INPUT}")
FILE_PATH=$(jq -r '.file_path // ""' <<< "${HOOK_INPUT}")

TIMESTAMP=$(date -Iseconds)

jq -nc --arg src "${SOURCE}" --arg file "${FILE_PATH}" --arg ts "${TIMESTAMP}" \
	'{event: "config_change", source: $src, file: $file, timestamp: $ts}' >>"${LOG_DIR}/config-changes.jsonl"

exit 0
