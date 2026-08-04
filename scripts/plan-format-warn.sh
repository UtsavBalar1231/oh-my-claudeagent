#!/bin/bash
# plan-format-warn.sh: PostToolUse (Write|Edit) advisory hook.
# Raw `- [ ]` checkboxes that don't match the numbered `- [ ] N.` form are
# invisible to boulder_progress/statusline counting; this names the offending
# lines at write time. Advisory only: never denies, always exits 0.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

_HOOK_START=$(epoch_ns)

hook_is_disabled "plan-format-warn" && exit 0

FILE_PATH=$(jq -r '.tool_input.file_path // ""' <<< "${HOOK_INPUT}")

# Mirrors validate_plan_write.py's _PLAN_PATH_RE exactly so the deny gate
# (zero-checkbox plans) and this advisory warning never disagree about scope.
if [[ ! "${FILE_PATH}" =~ /plans/[^/]+\.md$ ]]; then
	exit 0
fi

[[ -f "${FILE_PATH}" ]] || exit 0

read -r UNCHECKED _CHECKED _TOTAL RAW_UNCHECKED < <(count_plan_checkboxes "${FILE_PATH}")

if [[ "${RAW_UNCHECKED}" -le "${UNCHECKED}" ]]; then
	exit 0
fi

# 5: cap on named malformed lines; keeps additionalContext short for plans
# with many malformed boxes while still surfacing the common single-typo case.
MAX_NAMED_LINES=5

# Same raw-unchecked pattern as count_plan_checkboxes, minus lines that also
# satisfy the numbered pattern, i.e. exactly the malformed set.
MALFORMED_LINES=$(grep -nE '^- \[ \] ' "${FILE_PATH}" | grep -vE '^[0-9]+:- \[ \] [0-9]+\.')
TOTAL_MALFORMED=$((RAW_UNCHECKED - UNCHECKED))
NAMED=$(printf '%s\n' "${MALFORMED_LINES}" | head -n "${MAX_NAMED_LINES}")
REMAINING=$((TOTAL_MALFORMED - MAX_NAMED_LINES))

MSG="[PLAN-FORMAT-WARN] ${FILE_PATH} has ${TOTAL_MALFORMED} checkbox line(s) that will not be counted as numbered tasks:"$'\n'"${NAMED}"
if [[ "${REMAINING}" -gt 0 ]]; then
	MSG+=$'\n'"...and ${REMAINING} more"
fi
MSG+=$'\n'"Fix: a - [ ] line not matching '- [ ] N.' will not be counted; use the numbered form."

hook_timing_log "${_HOOK_START}"
emit_context "PostToolUse" "${MSG}"
