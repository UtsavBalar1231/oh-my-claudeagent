#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

_HOOK_START=$(epoch_ns)

noop_exit() {
	hook_timing_log "${_HOOK_START}"
	exit 0
}

TOOL_NAME=$(jq -r '.tool_name // ""' <<< "${HOOK_INPUT}")

if [[ "${TOOL_NAME}" == "SubagentHandback" ]]; then
	# Under auto mode the report travels only here, verbatim in tool_input.message;
	# agent_type on this payload is the handing-back subagent's own type.
	RESPONSE=$(jq -r '.tool_input.message // ""' <<< "${HOOK_INPUT}")
	AGENT_TYPE_FULL=$(jq -r '.agent_type // ""' <<< "${HOOK_INPUT}")
else
	# An async launch acknowledgement carries no report at all, and a completed
	# result with handback "send" carries only a pointer at the hand-back payload.
	STATUS=$(jq -r '.tool_response.status // ""' <<< "${HOOK_INPUT}")
	HANDBACK=$(jq -r '.tool_response.handback // ""' <<< "${HOOK_INPUT}")
	if [[ "${STATUS}" != "completed" ]] || [[ "${HANDBACK}" == "send" ]]; then
		noop_exit
	fi
	RESPONSE=$(jq -r '[.tool_response.content[]? | .text? // empty] | join("\n")' <<< "${HOOK_INPUT}")
	AGENT_TYPE_FULL=$(jq -r '.tool_input.subagent_type // ""' <<< "${HOOK_INPUT}")
fi

# A harness note can be prepended as one bracketed line; the report is what follows it.
if [[ "${RESPONSE}" == \[*\]* ]]; then
	if [[ "${RESPONSE}" == *$'\n'* ]]; then
		RESPONSE=${RESPONSE#*$'\n'}
	else
		RESPONSE=""
	fi
fi

RESPONSE_LENGTH=${#RESPONSE}

IS_POOR=false
if [[ "${RESPONSE_LENGTH}" -lt 50 ]] || [[ -z "$(echo "${RESPONSE}" | tr -d '[:space:]')" ]]; then
	IS_POOR=true
fi

# A finished agent legitimately ends with a terse terminal acknowledgement. Treating
# that as POOR and re-querying it is the "Done. Ending." re-query loop. A non-empty
# response that reads as a deliberate completion is VALID, never poor.
if [[ "${IS_POOR}" == "true" ]] && [[ -n "$(echo "${RESPONSE}" | tr -d '[:space:]')" ]]; then
	LOWER_RESPONSE=$(echo "${RESPONSE}" | tr '[:upper:]' '[:lower:]')
	if echo "${LOWER_RESPONSE}" | grep -qE '(done|ending|complete|completed|finished|no further|nothing (further|left|to do)|acknowledged|deliverable)'; then
		IS_POOR=false
	fi
fi

if [[ "${IS_POOR}" == "false" ]] && [[ "${RESPONSE_LENGTH}" -lt 200 ]]; then
	LOWER_RESPONSE=$(echo "${RESPONSE}" | tr '[:upper:]' '[:lower:]')
	if echo "${LOWER_RESPONSE}" | grep -qE '^(let me|now let me|i'\''ll |good\.|now i|ok,? let me|checking|looking at|reading |searching|next,? |i need to|i should|let'\''s |i want to|i'\''m going to|i will )'; then
		IS_POOR=true
	fi
fi

if [[ "${IS_POOR}" == "true" ]]; then
	MSG="[POOR AGENT OUTPUT] The agent returned empty or trivially short text with no synthesis. A rate limit, server error, or kill would have arrived as a delegation error carrying the agent's partial work, so an empty result here means the agent ended its own turn without a deliverable, typically after spending its turns on tool calls. Do NOT re-query the same agent (a finished agent is terminal; re-querying it loops). Relaunch a FRESH agent with a sharper prompt that states the required output format explicitly, or proceed with what you already have."
	emit_context "PostToolUse" "${MSG}"
else
	AGENT_TYPE="${AGENT_TYPE_FULL##*:}"
	MISSING_SECTIONS=""
	case "${AGENT_TYPE}" in
	executor)
		REQUIRED="STATUS: CHANGES: EVIDENCE:"
		;;
	explore)
		REQUIRED="FILES: ANSWER: NEXT STEPS:"
		;;
	oracle)
		REQUIRED="RECOMMENDATION: ALTERNATIVES: RISKS:"
		;;
	librarian)
		REQUIRED="SOURCES: FINDINGS: APPLICABILITY:"
		;;
	*)
		REQUIRED=""
		;;
	esac

	for section in ${REQUIRED}; do
		if ! echo "${RESPONSE}" | grep -qiE "${section}"; then
			MISSING_SECTIONS="${MISSING_SECTIONS} ${section}"
		fi
	done

	if [[ -n "${MISSING_SECTIONS}" ]]; then
		WARN="[ADVISORY] Agent '${AGENT_TYPE}' output is missing expected section headers:${MISSING_SECTIONS}. The required output format specifies these sections. Output may be incomplete or hard to parse downstream."
		emit_context "PostToolUse" "${WARN}"
	else
		noop_exit
	fi
fi

hook_timing_log "${_HOOK_START}"
