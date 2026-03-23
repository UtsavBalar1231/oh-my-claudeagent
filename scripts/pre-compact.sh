#!/bin/bash

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"
mkdir -p "${STATE_DIR}"

CONTEXT_FILE="${STATE_DIR}/compaction-context.md"
TMP_CONTEXT="${STATE_DIR}/compaction-context.tmp.$$"

{
	cat <<'TEMPLATE'
# Post-Compaction Context

## Active Mode
TEMPLATE

	if [[ -f "${STATE_DIR}/ralph-state.json" ]]; then
		STATUS=$(jq -r '.status // "inactive"' "${STATE_DIR}/ralph-state.json" 2>/dev/null)
		if [[ "${STATUS}" == "active" ]]; then
			printf '%s\n' "Ralph mode is ACTIVE. The boulder never stops. Continue working on incomplete tasks."
			BOULDER_FILE="${STATE_DIR}/boulder.json"
			if [[ -f "${BOULDER_FILE}" ]]; then
				printf '\n## Active Plan Reference\n'
				jq -r '.active_plan // "No plan file"' "${BOULDER_FILE}" 2>/dev/null || true
			fi
		fi
	fi

	if [[ -f "${STATE_DIR}/ultrawork-state.json" ]]; then
		STATUS=$(jq -r '.status // "inactive"' "${STATE_DIR}/ultrawork-state.json" 2>/dev/null)
		if [[ "${STATUS}" == "active" ]]; then
			printf '%s\n' "ultrawork mode is ACTIVE. Continue working."
		fi
	fi

	# Include subagent session data for RESUME, DON'T RESTART directive
	SUBAGENT_LOG="${LOG_DIR}/subagents.jsonl"
	ACTIVE_AGENTS=""
	if [[ -f "${SUBAGENT_LOG}" ]]; then
		ACTIVE_AGENTS=$(tail -50 "${SUBAGENT_LOG}" | jq -s '[.[] | select(.event == "subagent_spawn")] | .[-10:] | .[] | "- Agent: \(.type // "unknown"), SpawnID: \(.id // "unknown"), Model: \(.model // "default")"' 2>/dev/null | tr -d '"')
	fi

	printf '\n## Recently Spawned Agents\n'
	if [[ -n "${ACTIVE_AGENTS}" ]]; then
		printf '%s\n' "${ACTIVE_AGENTS}"
	else
		printf '%s\n' "No recent agent spawns recorded."
	fi
	printf '%s\n' "RESUME, DON'T RESTART: If an agent was working on a task before compaction, resume it with SendMessage({to: \"<agentId>\"}) rather than spawning a new one. Check subagent completion status before re-delegating."

	printf '\n## Pending Tasks\n'
	printf '%s\n' "Check boulder.json for active plan and remaining tasks."

	# Notepad section summaries
	NOTEPADS_DIR="${STATE_DIR}/notepads"
	if [[ -d "${NOTEPADS_DIR}" ]]; then
		printf '\n## Notepad Summaries\n'
		for PLAN_DIR in "${NOTEPADS_DIR}"/*/; do
			PLAN_NAME=$(basename "${PLAN_DIR}")
			printf '### Plan: %s\n' "${PLAN_NAME}"
			for SECTION_FILE in "${PLAN_DIR}"*.md; do
				[[ -f "${SECTION_FILE}" ]] || continue
				SECTION_NAME=$(basename "${SECTION_FILE}" .md)
				LINE_COUNT=$(wc -l <"${SECTION_FILE}" 2>/dev/null || echo 0)
				printf '- %s: %s lines\n' "${SECTION_NAME}" "${LINE_COUNT}"
			done
		done
	fi

	# Latest verification evidence
	EVIDENCE_FILE="${STATE_DIR}/verification-evidence.json"
	if [[ -f "${EVIDENCE_FILE}" ]]; then
		printf '\n## Latest Verification Evidence\n'
		LATEST=$(jq -r '.entries | last | "type=\(.type) cmd=\(.command) exit=\(.exit_code) ts=\(.timestamp)"' "${EVIDENCE_FILE}" 2>/dev/null || echo "")
		if [[ -n "${LATEST}" ]]; then
			printf '%s\n' "${LATEST}"
		else
			printf '%s\n' "No evidence entries."
		fi
	fi
} >"${TMP_CONTEXT}"

if ! mv "${TMP_CONTEXT}" "${CONTEXT_FILE}" 2>/dev/null; then
	rm -f "${TMP_CONTEXT}"
fi

exit 0
