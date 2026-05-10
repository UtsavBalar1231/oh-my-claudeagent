#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

_HOOK_START=$(date +%s%N)

# Agent tool returns tool_response as a structured object {result: "..."}; other
# tools return a plain string. Extract the inner .result when present.
_RAW_RESPONSE=$(jq -r '.tool_response // ""' <<< "${HOOK_INPUT}")
if echo "${_RAW_RESPONSE}" | jq -e 'type == "object" and has("result")' >/dev/null 2>&1; then
	RESPONSE=$(echo "${_RAW_RESPONSE}" | jq -r '.result // ""')
else
	RESPONSE="${_RAW_RESPONSE}"
fi

RESPONSE_LENGTH=${#RESPONSE}

IS_POOR=false
if [[ "${RESPONSE_LENGTH}" -lt 50 ]] || [[ -z "$(echo "${RESPONSE}" | tr -d '[:space:]')" ]]; then
	IS_POOR=true
fi

if [[ "${IS_POOR}" == "false" ]] && [[ "${RESPONSE_LENGTH}" -lt 200 ]]; then
	LOWER_RESPONSE=$(echo "${RESPONSE}" | tr '[:upper:]' '[:lower:]')
	if echo "${LOWER_RESPONSE}" | grep -qE '^(let me|now let me|i'\''ll |good\.|now i|ok,? let me|checking|looking at|reading |searching|next,? |i need to|i should|let'\''s |i want to|i'\''m going to|i will )'; then
		IS_POOR=true
	fi
fi

if [[ "${IS_POOR}" == "true" ]]; then
	MSG="[POOR AGENT OUTPUT] The agent returned empty, trivially short, or transitional text instead of a structured synthesis. The agent likely exhausted its turns on tool calls without producing a final summary. Consider: 1) Use SendMessage to resume the agent and ask it to synthesize its findings, 2) Retry with a more specific prompt that includes explicit output format requirements, 3) Check if the agent had the right tools for the task."
	emit_context "PostToolUse" "${MSG}"
else
	USAGE_FILE="${HOOK_STATE_DIR}/agent-usage.json"
	if [[ -f "${USAGE_FILE}" ]]; then
		TMP=$(mktemp)
		jq '.agentUsed = true' "${USAGE_FILE}" >"${TMP}" && mv "${TMP}" "${USAGE_FILE}"
	fi

	# Canonical platform path: subagent_type is nested under tool_input (not top-level).
	AGENT_TYPE_FULL=$(jq -r '.tool_input.subagent_type // ""' <<< "${HOOK_INPUT}")
	AGENT_TYPE="${AGENT_TYPE_FULL##*:}"
	MISSING_SECTIONS=""
	case "${AGENT_TYPE}" in
	executor)
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
		;;
	esac

	if [[ -n "${MISSING_SECTIONS}" ]]; then
		WARN="[ADVISORY] Agent '${AGENT_TYPE}' output is missing expected section headers:${MISSING_SECTIONS}. The required output format specifies these sections. Output may be incomplete or hard to parse downstream."
		emit_context "PostToolUse" "${WARN}"
	else
		hook_timing_log "${_HOOK_START}"
		exit 0
	fi
fi

hook_timing_log "${_HOOK_START}"
