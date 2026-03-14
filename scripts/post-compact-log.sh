#!/bin/bash

# PostCompact hook — observability/enrichment only (no additionalContext support)
# Enriches compaction-context.md with the compact_summary if available,
# and logs the compaction event to sessions.jsonl.

INPUT=$(cat)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"

mkdir -p "${STATE_DIR}" "${LOG_DIR}"

TRIGGER=$(echo "${INPUT}" | jq -r '.trigger // "unknown"' 2>/dev/null)
COMPACT_SUMMARY=$(echo "${INPUT}" | jq -r '.compact_summary // ""' 2>/dev/null)

# Log compaction event
jq -nc \
	--arg ts "$(date -Iseconds)" \
	--arg trigger "${TRIGGER}" \
	--arg has_summary "$( [ -n "${COMPACT_SUMMARY}" ] && echo "true" || echo "false" )" \
	'{event: "post_compact", timestamp: $ts, trigger: $trigger, hasSummary: $has_summary}' \
	>>"${LOG_DIR}/sessions.jsonl"

# Enrich compaction-context.md with compact_summary
if [[ -n "${COMPACT_SUMMARY}" ]]; then
	CONTEXT_FILE="${STATE_DIR}/compaction-context.md"
	if [[ -f "${CONTEXT_FILE}" ]]; then
		# Append compact summary to existing context written by pre-compact.sh
		printf '\n## Compact Summary\n%s\n' "${COMPACT_SUMMARY}" >>"${CONTEXT_FILE}"
	else
		# No pre-compact context exists; create with just the summary
		printf '# Post-Compaction Context\n\n## Compact Summary\n%s\n' "${COMPACT_SUMMARY}" >"${CONTEXT_FILE}"
	fi
fi

exit 0
