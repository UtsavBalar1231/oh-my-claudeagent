#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"

EVIDENCE_FILE=$(resolve_evidence_file "${STATE_DIR}")

# Resolve THIS session's bound plan via the shared shim — never hand-parse boulder.json.
BOULDER_RESOLVED=$(python3 "${PLUGIN_ROOT}/servers/tools/boulder_resolve.py" "$(resolve_session_id)" "${HOOK_PROJECT_ROOT}" 2>/dev/null)
PLAN_FILE=$(jq -r '.active_plan // ""' <<< "${BOULDER_RESOLVED:-{}}" 2>/dev/null)
PLAN_NAME=$(jq -r '.plan_name // ""' <<< "${BOULDER_RESOLVED:-{}}" 2>/dev/null)

CONTEXT_FILE="${STATE_DIR}/compaction-context.md"
TMP_CONTEXT="${STATE_DIR}/compaction-context.tmp.$$"

{
	cat <<'TEMPLATE'
# Post-Compaction Context
TEMPLATE

	# Tasks ALWAYS emitted before decisions: post-compact-inject.sh truncates at
	# 150/100 lines downstream, so tasks must survive that cap first.
	printf '\n## Remaining tasks\n'
	if [[ -n "${PLAN_FILE}" && -f "${PLAN_FILE}" ]]; then
		# 10 — next unchecked tasks kept inline; rest still reachable via boulder.json.
		MAX_TASKS=10
		TASKS=$(grep -E '^[[:space:]]*- \[ \] ' "${PLAN_FILE}" | head -n "${MAX_TASKS}")
		TOTAL_TASKS=$(grep -cE '^[[:space:]]*- \[ \] ' "${PLAN_FILE}" || true)
		TOTAL_TASKS="${TOTAL_TASKS:-0}"
		if [[ -n "${TASKS}" ]]; then
			printf '%s\n' "${TASKS}"
			if [[ "${TOTAL_TASKS}" -gt "${MAX_TASKS}" ]]; then
				printf -- '…%d more (see boulder.json / notepad)\n' "$((TOTAL_TASKS - MAX_TASKS))"
			fi
		else
			printf '%s\n' "No remaining unchecked tasks found in plan."
		fi
	else
		printf '%s\n' "Check boulder.json for active plan and remaining tasks."
	fi

	printf '\n## Decisions\n'
	DECISIONS_FILE="${STATE_DIR}/notepads/${PLAN_NAME}/decisions.md"
	if [[ -n "${PLAN_NAME}" && -f "${DECISIONS_FILE}" ]]; then
		# 5 — most-recent decisions kept inline; older ones still live in the notepad file.
		MAX_DECISIONS=5
		HEADER_LINES=$(grep -n '^## [0-9]\{4\}-' "${DECISIONS_FILE}" | cut -d: -f1)
		TOTAL_DECISIONS=$(printf '%s\n' "${HEADER_LINES}" | grep -c . || true)
		TOTAL_DECISIONS="${TOTAL_DECISIONS:-0}"
		if [[ "${TOTAL_DECISIONS}" -gt 0 ]]; then
			START_LINE=$(printf '%s\n' "${HEADER_LINES}" | tail -n "${MAX_DECISIONS}" | head -n1)
			tail -n "+${START_LINE}" "${DECISIONS_FILE}"
			if [[ "${TOTAL_DECISIONS}" -gt "${MAX_DECISIONS}" ]]; then
				printf -- '…%d more (see boulder.json / notepad)\n' "$((TOTAL_DECISIONS - MAX_DECISIONS))"
			fi
		else
			printf '%s\n' "No decisions recorded yet."
		fi
	else
		printf '%s\n' "No decisions recorded yet."
	fi

	NOTEPADS_DIR="${STATE_DIR}/notepads"
	if [[ -d "${NOTEPADS_DIR}" ]]; then
		printf '\n## Notepad Summaries\n'
		for PLAN_DIR in "${NOTEPADS_DIR}"/*/; do
			NOTEPAD_PLAN_NAME=$(basename "${PLAN_DIR}")
			printf '### Plan: %s\n' "${NOTEPAD_PLAN_NAME}"
			for SECTION_FILE in "${PLAN_DIR}"*.md; do
				[[ -f "${SECTION_FILE}" ]] || continue
				SECTION_NAME=$(basename "${SECTION_FILE}" .md)
				LINE_COUNT=$(wc -l <"${SECTION_FILE}")
				printf -- '- %s: %s lines\n' "${SECTION_NAME}" "${LINE_COUNT}"
			done
		done
	fi

	if [[ -f "${EVIDENCE_FILE}" ]]; then
		printf '\n## Latest Verification Evidence\n'
		LATEST=$(jq -r '.entries | last | "type=\(.type) cmd=\(.command) exit=\(.exit_code) ts=\(.timestamp)"' "${EVIDENCE_FILE}")
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
