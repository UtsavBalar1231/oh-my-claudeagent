#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
CONTEXT_FILE="${STATE_DIR}/compaction-context.md"
CLAIM_FILE="${STATE_DIR}/compaction-context.restore.$$"

if [[ ! -f "${CONTEXT_FILE}" ]]; then
	exit 0
fi

if ! mv "${CONTEXT_FILE}" "${CLAIM_FILE}" 2>/dev/null; then
	exit 0
fi

trap 'rm -f "${CLAIM_FILE}"' EXIT

# Security: validate size and content before injecting compaction context.
# An attacker who can write to compaction-context.md could inject prompt content
# into the next session. Truncate oversized files and strip obvious injection patterns.
LINE_COUNT=$(wc -l < "${CLAIM_FILE}" 2>/dev/null || echo 0)
if [[ "${LINE_COUNT}" -gt 200 ]]; then
	# Truncate to 200 lines with a visible warning so the model knows it was cut
	TRUNCATED=$(head -n 200 "${CLAIM_FILE}")
	printf '%s\n[TRUNCATED: compaction context exceeded 200 lines and was cut]\n' "${TRUNCATED}" > "${CLAIM_FILE}"
fi

# Strip lines that look like prompt injection attempts (same patterns as notepad sanitization).
# Patterns: <system>, [SYSTEM], </instructions>, <|im_start|>system
CLEANED=$(grep -viE '^\s*(<system>|\[system\]|</instructions>|<\|im_start\|>system|<\|im_end\|>|system prompt:|</system>)' "${CLAIM_FILE}" 2>/dev/null || true)
if [[ -z "${CLEANED}" ]]; then
	CLEANED=$(cat "${CLAIM_FILE}" 2>/dev/null || true)
fi

CLEANED_LINES=$(echo "${CLEANED}" | wc -l 2>/dev/null || echo 0)

# Dynamic truncation: preserve complete sections up to 150 lines if structured,
# otherwise keep first 100 lines. Append truncation marker when content is cut.
if echo "${CLEANED}" | grep -q '^## ' 2>/dev/null; then
	LIMIT=150
else
	LIMIT=100
fi

if [[ "${CLEANED_LINES}" -le "${LIMIT}" ]]; then
	CONTEXT="${CLEANED}"
else
	REMOVED=$((CLEANED_LINES - LIMIT))
	CONTEXT=$(echo "${CLEANED}" | head -n "${LIMIT}")
	CONTEXT="${CONTEXT}
[TRUNCATED: ${REMOVED} lines removed]"
fi

if [[ -z "${CONTEXT}" ]]; then
	exit 0
fi

# Fresh date after compaction (time may have passed)
DATE_FRESH=$(LC_TIME=C date '+%A %B %d %Y %H' 2>/dev/null || echo "")
if [[ -n "${DATE_FRESH}" ]]; then
	read -r DOW MON DAY YEAR HOUR <<< "${DATE_FRESH}"
	DATE_BLOCK="[CURRENT DATE] Today is ${DOW}, ${MON} ${DAY}, ${YEAR}. Current hour: ${HOUR} (local)."
	ESCAPED=$(printf '%s\n[POST-COMPACTION CONTEXT RESTORE] %s' "${DATE_BLOCK}" "${CONTEXT}" | jq -Rs .)
else
	ESCAPED=$(printf '[POST-COMPACTION CONTEXT RESTORE] %s' "${CONTEXT}" | jq -Rs .)
fi
echo "{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": ${ESCAPED}}}"
