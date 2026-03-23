#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"

RESPONSE=$(echo "${INPUT}" | jq -r '.tool_response // .tool_result // ""' 2>/dev/null)

RESPONSE_LENGTH=${#RESPONSE}

# Check for empty/very short responses
IS_POOR=false
if [[ "${RESPONSE_LENGTH}" -lt 50 ]] || [[ -z "$(echo "${RESPONSE}" | tr -d '[:space:]' || true)" ]]; then
	IS_POOR=true
fi

# Check for transitional patterns in short responses (< 200 chars)
if [[ "${IS_POOR}" == "false" ]] && [[ "${RESPONSE_LENGTH}" -lt 200 ]]; then
	LOWER_RESPONSE=$(echo "${RESPONSE}" | tr '[:upper:]' '[:lower:]')
	if echo "${LOWER_RESPONSE}" | grep -qE '^(let me|now let me|i'\''ll |good\.|now i|ok,? let me|checking|looking at|reading |searching|next,? |i need to|i should|let'\''s |i want to|i'\''m going to|i will )'; then
		IS_POOR=true
	fi
fi

if [[ "${IS_POOR}" == "true" ]]; then
	MSG="[POOR AGENT OUTPUT] The agent returned empty, trivially short, or transitional text instead of a structured synthesis. The agent likely exhausted its turns on tool calls without producing a final summary. Consider: 1) Use SendMessage to resume the agent and ask it to synthesize its findings, 2) Retry with a more specific prompt that includes explicit output format requirements, 3) Check if the agent had the right tools for the task."
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": ${ESCAPED}}}"
else
	USAGE_FILE="${HOOK_STATE_DIR}/agent-usage.json"
	if [[ -f "${USAGE_FILE}" ]]; then
		TMP=$(mktemp)
		jq '.agentUsed = true' "${USAGE_FILE}" >"${TMP}" && mv "${TMP}" "${USAGE_FILE}"
	fi

	# Soft validation: check for required output sections by agent type (advisory only)
	AGENT_TYPE=$(echo "${INPUT}" | jq -r '.agent_name // .subagent_type // ""' 2>/dev/null | sed 's/.*://')
	MISSING_SECTIONS=""
	case "${AGENT_TYPE}" in
	sisyphus-junior)
		REQUIRED="STATUS: CHANGES: EVIDENCE:"
		for section in ${REQUIRED}; do
			if ! echo "${RESPONSE}" | grep -qiE "${section}"; then
				MISSING_SECTIONS="${MISSING_SECTIONS} ${section}"
			fi
		done
		;;
	explore)
		REQUIRED="FILES: ANSWER: NEXT STEPS:"
		for section in ${REQUIRED}; do
			if ! echo "${RESPONSE}" | grep -qiE "${section}"; then
				MISSING_SECTIONS="${MISSING_SECTIONS} ${section}"
			fi
		done
		;;
	oracle)
		REQUIRED="RECOMMENDATION: ALTERNATIVES: RISKS:"
		for section in ${REQUIRED}; do
			if ! echo "${RESPONSE}" | grep -qiE "${section}"; then
				MISSING_SECTIONS="${MISSING_SECTIONS} ${section}"
			fi
		done
		;;
	librarian)
		REQUIRED="SOURCES: FINDINGS: APPLICABILITY:"
		for section in ${REQUIRED}; do
			if ! echo "${RESPONSE}" | grep -qiE "${section}"; then
				MISSING_SECTIONS="${MISSING_SECTIONS} ${section}"
			fi
		done
		;;
	*)
		# No required sections defined for this agent type
		;;
	esac

	if [[ -n "${MISSING_SECTIONS}" ]]; then
		WARN="[ADVISORY] Agent '${AGENT_TYPE}' output is missing expected section headers:${MISSING_SECTIONS}. The required output format specifies these sections. Output may be incomplete or hard to parse downstream."
		ESCAPED=$(echo "${WARN}" | jq -Rs .)
		echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": ${ESCAPED}}}"
	else
		exit 0
	fi
fi
