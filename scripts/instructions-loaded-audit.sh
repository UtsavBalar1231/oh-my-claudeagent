#!/bin/bash

INPUT=$(cat)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"
LOG_FILE="${LOG_DIR}/instructions-loaded.jsonl"
TIMESTAMP=$(date -Iseconds)

mkdir -p "${LOG_DIR}"

ENTRY=$(printf '%s' "${INPUT}" | jq -c --arg ts "${TIMESTAMP}" '
	{
		hook_event_name: (.hook_event_name // "InstructionsLoaded"),
		file_path: (.file_path // null),
		memory_type: (.memory_type // null),
		load_reason: (.load_reason // null),
		timestamp: $ts
	}
	+ (if .session_id? != null then {session_id: .session_id} else {} end)
	+ (if .cwd? != null then {cwd: .cwd} else {} end)
	+ (if .globs? != null then {globs: .globs} else {} end)
	+ (if .trigger_file_path? != null then {trigger_file_path: .trigger_file_path} else {} end)
	+ (if .parent_file_path? != null then {parent_file_path: .parent_file_path} else {} end)
' 2>/dev/null)

if [[ -n "${ENTRY}" ]]; then
	printf '%s\n' "${ENTRY}" >>"${LOG_FILE}"
fi

exit 0
