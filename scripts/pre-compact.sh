#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

EVIDENCE_FILE=$(resolve_evidence_file "${STATE_DIR}")

CONTEXT_FILE="${STATE_DIR}/compaction-context.md"
TMP_CONTEXT="${STATE_DIR}/compaction-context.tmp.$$"

{
	cat <<'TEMPLATE'
# Post-Compaction Context
TEMPLATE

	printf '\n## Pending Tasks\n'
	printf '%s\n' "Check boulder.json for active plan and remaining tasks."

	NOTEPADS_DIR="${STATE_DIR}/notepads"
	if [[ -d "${NOTEPADS_DIR}" ]]; then
		printf '\n## Notepad Summaries\n'
		for PLAN_DIR in "${NOTEPADS_DIR}"/*/; do
			PLAN_NAME=$(basename "${PLAN_DIR}")
			printf '### Plan: %s\n' "${PLAN_NAME}"
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
