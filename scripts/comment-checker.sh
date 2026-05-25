#!/bin/bash

_HOOK_START=$(date +%s%N 2>/dev/null || date +%s)

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

json_content=$(jq -r '
  def file_payloads:
    [ .tool_response.files?, .tool_response.result.files?, .tool_response.metadata.files? ]
    | map(select(type == "array")[]?)
    | map(
        select((.type? // "") != "delete")
        | (.after? // .new? // .newString? // .new_string? // empty)
        | select(type == "string")
      )
    | .[];

  (
    .tool_input.content?,
    .tool_input.new_string?,
    (.tool_input.edits? | if type == "array" then .[] else empty end | (.new_string? // .newString? // empty)),
    file_payloads
  )
  | select(type == "string")
' <<< "${HOOK_INPUT}" 2>/dev/null || true)

patch_content=$(jq -r '
  (
    .tool_input.patchText?,
    .tool_input.input?,
    .tool_input.patch?,
    .tool_input.command?
  )
  | select(type == "string")
' <<< "${HOOK_INPUT}" 2>/dev/null \
  | awk '
      /^\+\+\+/ { next }
      /^\+/ { sub(/^\+/, ""); print }
    ' || true)

CONTENT=$(printf '%s\n%s' "${json_content}" "${patch_content}")

if [[ -z "${CONTENT}" ]]; then
	exit 0
fi

WARNINGS=""

if echo "${CONTENT}" | grep -qi "# AI-generated"; then
	WARNINGS+="AI attribution comment detected. "
fi

if echo "${CONTENT}" | grep -qi "# This code was written by"; then
	WARNINGS+="AI authorship comment detected. "
fi

if echo "${CONTENT}" | grep -qi "TODO: implement"; then
	WARNINGS+="Unimplemented TODO placeholder detected. "
fi

CONSECUTIVE=$(echo "${CONTENT}" | awk '
  /^[[:space:]]*#/ || /^[[:space:]]*\/\// { count++; if (count > max) max = count; next }
  { count = 0 }
  END { print max+0 }
')
if [[ "${CONSECUTIVE}" -gt 5 ]]; then
	WARNINGS+="Excessive consecutive comment lines (${CONSECUTIVE} in a row) detected. "
fi

hook_timing_log "${_HOOK_START}"

if [[ -n "${WARNINGS}" ]]; then
	MSG="[COMMENT CHECK] Detected potential AI slop patterns. Review the written content for unnecessary comments or placeholder code. Details: ${WARNINGS}"
	emit_context "PostToolUse" "${MSG}"
else
	exit 0
fi
