#!/usr/bin/env bash
# One-shot sweep: removes hook-errors.jsonl entries where .timestamp == "" AND
# .hook == "post-edit.sh". Run manually; do NOT register in hooks/hooks.json.
# Usage: sweep-stale-log-entries.sh [/path/to/hook-errors.jsonl]

# shellcheck source=scripts/lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${1:-${HOOK_LOG_DIR}/hook-errors.jsonl}"

if [[ ! -f "${INPUT}" ]]; then
	exit 0
fi

# Count total lines before sweep.
BEFORE=$(wc -l < "${INPUT}")

TMP=$(mktemp) || {
	log_hook_error "mktemp failed" "$(basename "$0")"
	exit 0
}

# Keep entries that do NOT match (timestamp == "" AND hook == "post-edit.sh").
# jq select: keep when timestamp is non-empty OR hook differs from post-edit.sh.
if ! jq -c 'select(.timestamp != "" or .hook != "post-edit.sh")' "${INPUT}" > "${TMP}" 2>/dev/null; then
	rm -f "${TMP}"
	log_hook_error "jq filter failed" "$(basename "$0")"
	exit 0
fi

mv "${TMP}" "${INPUT}"

AFTER=$(wc -l < "${INPUT}")
REMOVED=$(( BEFORE - AFTER ))

echo "sweep-stale-log-entries: ${INPUT}: ${BEFORE} -> ${AFTER} lines (removed ${REMOVED} stale entries)"
