#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

# active-modes.json path — shared via common.sh (ACTIVE_MODES_FILE, mode_already_announced, mark_mode_announced)

# agent_id is only present in hook payloads fired inside a subagent call, not in top-level session hooks
AGENT_ID=$(jq -r '.agent_id // ""' <<< "${HOOK_INPUT}")
if [[ -n "${AGENT_ID}" ]]; then
	exit 0
fi

PROMPT=$(jq -r '.prompt // ""' <<< "${HOOK_INPUT}")

if [[ -z "${PROMPT}" ]]; then
	exit 0
fi

# Task-notification relays (background-agent results) arrive as user turns with no agent_id.
# Skip detection when the tag appears in the first 500 chars (wrappers may precede it);
# a real user prompt containing the literal tag is suppressed — acceptable, it's platform XML.
PROMPT_HEAD="${PROMPT:0:500}"
if [[ "${PROMPT_HEAD}" == *"<task-notification>"* ]]; then
	exit 0
fi

# CURRENT_SESSION is referenced by mode_already_announced / mark_mode_announced in common.sh
# shellcheck disable=SC2034
CURRENT_SESSION=$(resolve_session_id)

PROMPT_LOWER=$(echo "${PROMPT}" | tr '[:upper:]' '[:lower:]')

DETECTED_KEYWORDS=()
ADDITIONAL_CONTEXT=""

if ! mode_already_announced "handoff" \
	&& [[ "${PROMPT_LOWER}" =~ (handoff|context[[:space:]]+is[[:space:]]+getting[[:space:]]+long|start[[:space:]]+fresh[[:space:]]+session) ]]; then
	DETECTED_KEYWORDS+=("handoff")
	ADDITIONAL_CONTEXT+="[HANDOFF MODE DETECTED] Create session handoff summary for new-session continuity."$'\n'
fi

if ! mode_already_announced "omca-setup" \
	&& [[ "${PROMPT_LOWER}" =~ (setup[[:space:]]+omca|omca[[:space:]]+setup) ]]; then
	DETECTED_KEYWORDS+=("omca-setup")
	ADDITIONAL_CONTEXT+="[OMCA-SETUP DETECTED] Run /oh-my-claudeagent:omca-setup to configure the environment."$'\n'
fi

if ! mode_already_announced "metis" \
	&& [[ "${PROMPT_LOWER}" =~ (run[[:space:]]+metis|metis[[:space:]]+analyze|pre-plan) ]]; then
	DETECTED_KEYWORDS+=("metis")
	ADDITIONAL_CONTEXT+="[METIS DETECTED] Invoke /oh-my-claudeagent:metis for pre-planning analysis."$'\n'
fi

if ! mode_already_announced "plan" \
	&& [[ "${PROMPT_LOWER}" =~ (run[[:space:]]+prometheus|prometheus[[:space:]]+plan|create[[:space:]]+plan) ]]; then
	DETECTED_KEYWORDS+=("plan")
	ADDITIONAL_CONTEXT+="[PROMETHEUS DETECTED] Invoke /oh-my-claudeagent:plan for strategic planning via prometheus."$'\n'
fi

if ! mode_already_announced "hephaestus" \
	&& [[ "${PROMPT_LOWER}" =~ (run[[:space:]]+hephaestus|hephaestus[[:space:]]+fix|fix[[:space:]]+build|build[[:space:]]+broken) ]]; then
	DETECTED_KEYWORDS+=("hephaestus")
	ADDITIONAL_CONTEXT+="[HEPHAESTUS DETECTED] Invoke /oh-my-claudeagent:hephaestus to fix build failures."$'\n'
fi

if [[ ${#DETECTED_KEYWORDS[@]} -gt 0 ]]; then
	STATE_FILE="${HOOK_STATE_DIR}/session.json"

	if [[ -f "${STATE_FILE}" ]]; then
		KEYWORDS_JSON=$(printf '%s\n' "${DETECTED_KEYWORDS[@]}" | jq -R . | jq -s .)
		TMP_FILE=$(mktemp)
		jq --argjson keywords "${KEYWORDS_JSON}" '.detectedKeywords = $keywords' "${STATE_FILE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${STATE_FILE}"
	fi

	# Mark each newly-detected mode as announced for this session to suppress echo re-fires.
	for _kw in "${DETECTED_KEYWORDS[@]}"; do
		mark_mode_announced "${_kw}"
	done
fi

if [[ -n "${ADDITIONAL_CONTEXT}" ]]; then
	emit_context "UserPromptSubmit" "${ADDITIONAL_CONTEXT}"
else
	exit 0
fi
