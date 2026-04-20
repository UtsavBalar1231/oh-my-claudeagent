#!/bin/bash

# PostCompact hook — observability/enrichment only (no additionalContext support)
# Enriches compaction-context.md with the compact_summary if available,
# and logs the compaction event to sessions.jsonl.

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

TRIGGER=$(jq -r '.trigger // "unknown"' <<< "${HOOK_INPUT}")
COMPACT_SUMMARY=$(jq -r '.compact_summary // ""' <<< "${HOOK_INPUT}")

TS=$(date -Iseconds)
[[ -n "${COMPACT_SUMMARY}" ]] && HAS_SUMMARY="true" || HAS_SUMMARY="false"
jq -nc \
	--arg ts "${TS}" \
	--arg trigger "${TRIGGER}" \
	--arg has_summary "${HAS_SUMMARY}" \
	'{event: "post_compact", timestamp: $ts, trigger: $trigger, hasSummary: $has_summary}' \
	>>"${LOG_DIR}/sessions.jsonl"

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
