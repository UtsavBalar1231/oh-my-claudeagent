#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

# active-modes.json schema: top-level object keyed by mode name;
# each value is {"detected_at": <unix epoch>, "session_id": "<sid>"}.
ACTIVE_MODES_FILE="${STATE_DIR}/active-modes.json"

# agent_id is only present in hook payloads fired inside a subagent call, not in top-level session hooks
AGENT_ID=$(jq -r '.agent_id // ""' <<< "${HOOK_INPUT}")
if [[ -n "${AGENT_ID}" ]]; then
	exit 0
fi

PROMPT=$(jq -r '.prompt // ""' <<< "${HOOK_INPUT}")
RALPH_STATE="${STATE_DIR}/ralph-state.json"
ULTRAWORK_STATE="${STATE_DIR}/ultrawork-state.json"

if [[ -z "${PROMPT}" ]]; then
	exit 0
fi

CURRENT_SESSION=$(resolve_session_id)

# Returns 0 if the mode is already active in this session (suppress re-announce).
# Returns 1 if mode is absent, from a different session, or marker file is missing.
mode_already_announced() {
	local mode="$1"
	local stored_sid
	stored_sid=$(jq_read "${ACTIVE_MODES_FILE}" ".${mode}.session_id // \"\"")
	[[ -n "${stored_sid}" && "${stored_sid}" == "${CURRENT_SESSION}" ]]
}

# Write or update a mode entry in active-modes.json. Log and continue on failure.
mark_mode_announced() {
	local mode="$1"
	local now_epoch
	now_epoch=$(date +%s)
	# Initialize file as {} if missing
	local base="{}"
	if [[ -f "${ACTIVE_MODES_FILE}" ]]; then
		base=$(cat "${ACTIVE_MODES_FILE}")
	fi
	local tmp
	tmp=$(mktemp) || { log_hook_error "mktemp failed for active-modes.json" "$(basename "$0")"; return 0; }
	if printf '%s\n' "${base}" | jq \
		--arg mode "${mode}" \
		--argjson epoch "${now_epoch}" \
		--arg sid "${CURRENT_SESSION}" \
		'.[$mode] = {"detected_at": $epoch, "session_id": $sid}' > "${tmp}" 2>/dev/null; then
		mv "${tmp}" "${ACTIVE_MODES_FILE}" || log_hook_error "mv failed for active-modes.json" "$(basename "$0")"
	else
		rm -f "${tmp}"
		log_hook_error "jq update failed for active-modes.json mode=${mode}" "$(basename "$0")"
	fi
}

PROMPT_LOWER=$(echo "${PROMPT}" | tr '[:upper:]' '[:lower:]')

DETECTED_KEYWORDS=()
ADDITIONAL_CONTEXT=""

if ! mode_already_announced "ralph" \
	&& { [[ "${PROMPT_LOWER}" =~ (ralph|don\'t[[:space:]]+stop|must[[:space:]]+complete|until[[:space:]]+done|keep[[:space:]]+going[[:space:]]+until|finish[[:space:]]+this[[:space:]]+no[[:space:]]+matter) ]] \
		|| [[ "${PROMPT}" =~ (멈추지|止まるな|不要停) ]]; }; then
	DETECTED_KEYWORDS+=("ralph")
	ADDITIONAL_CONTEXT+="[RALPH MODE DETECTED] Activate persistence mode - do not stop until verified complete."$'\n'
fi

if ! mode_already_announced "ultrawork" \
	&& { [[ "${PROMPT_LOWER}" =~ (ulw|ultrawork|as[[:space:]]+fast[[:space:]]+as[[:space:]]+possible|run[[:space:]]+in[[:space:]]+parallel|simultaneously) ]] \
		|| [[ "${PROMPT}" =~ (울트라워크|ウルトラワーク|极限工作) ]]; }; then
	DETECTED_KEYWORDS+=("ultrawork")
	ADDITIONAL_CONTEXT+="[ULTRAWORK MODE DETECTED] Activate maximum parallel execution."$'\n'
fi

if ! mode_already_announced "stop-continuation" \
	&& [[ "${PROMPT_LOWER}" =~ (stop[[:space:]]+continuation|pause[[:space:]]+automation|take[[:space:]]+manual[[:space:]]+control) ]]; then
	DETECTED_KEYWORDS+=("stop-continuation")
	ADDITIONAL_CONTEXT+="[STOP CONTINUATION DETECTED] Halt all automated work — ralph and boulder state."$'\n'
fi

if ! mode_already_announced "cancel" \
	&& [[ "${PROMPT_LOWER}" =~ (cancel[[:space:]]+(this|task|run|operation|all)|stop[[:space:]]+(everything|now|all|task)|abort[[:space:]]+(this|task|run)) ]]; then
	DETECTED_KEYWORDS+=("cancel")
	ADDITIONAL_CONTEXT+="[CANCEL DETECTED] User wants to stop current operation. Invoke cancel skill."$'\n'
fi

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

# Conflict guard: ralph and ultrawork are mutually exclusive persistence modes.
# If both appear in the same prompt, prefer ralph (stricter — never-stop beats max-parallel).
# A user sending only 'ultrawork' in a new prompt can activate it even if ralph.json exists
# from a prior session — conflict prevention only applies within the same prompt.
HAS_RALPH=0
HAS_ULTRAWORK=0
[[ " ${DETECTED_KEYWORDS[*]} " =~ " ralph " ]] && HAS_RALPH=1
[[ " ${DETECTED_KEYWORDS[*]} " =~ " ultrawork " ]] && HAS_ULTRAWORK=1

if [[ "${HAS_RALPH}" -eq 1 ]] && [[ ! " ${DETECTED_KEYWORDS[*]} " =~ " stop-continuation " ]]; then
	if [[ "${HAS_ULTRAWORK}" -eq 1 ]] && [[ -f "${ULTRAWORK_STATE}" ]]; then
		rm -f "${ULTRAWORK_STATE}"
	fi
	NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	RALPH_TMP=$(mktemp) && printf '{"status":"active","activatedAt":"%s","tasks":[],"last_task_hash":"","stagnation_count":0}\n' \
		"${NOW_ISO}" > "${RALPH_TMP}" && mv "${RALPH_TMP}" "${RALPH_STATE}"
fi

if [[ "${HAS_ULTRAWORK}" -eq 1 ]] && [[ "${HAS_RALPH}" -eq 0 ]] \
	&& [[ ! " ${DETECTED_KEYWORDS[*]} " =~ " stop-continuation " ]]; then
	NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	UW_TMP=$(mktemp) && printf '{"status":"active","activatedAt":"%s","stagnation_count":0}\n' \
		"${NOW_ISO}" > "${UW_TMP}" && mv "${UW_TMP}" "${ULTRAWORK_STATE}"
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
