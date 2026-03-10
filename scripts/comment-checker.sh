#!/bin/bash

INPUT=$(cat)

CONTENT=$(echo "${INPUT}" | jq -r '.tool_input.new_string // .tool_input.content // ""' 2>/dev/null)

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

if [[ -n "${WARNINGS}" ]]; then
	MSG="[COMMENT CHECK] Detected potential AI slop patterns. Review the written content for unnecessary comments or placeholder code. Details: ${WARNINGS}"
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": ${ESCAPED}}}"
else
	exit 0
fi
