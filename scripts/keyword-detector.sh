#!/bin/bash

INPUT=$(cat)

PROMPT=$(echo "${INPUT}" | jq -r '.prompt // empty' 2>/dev/null || echo "")

if [[ -z "${PROMPT}" ]]; then
	exit 0
fi

PROMPT_LOWER=$(echo "${PROMPT}" | tr '[:upper:]' '[:lower:]')

DETECTED_KEYWORDS=()
ADDITIONAL_CONTEXT=""

if [[ "${PROMPT_LOWER}" =~ (ralph|don\'t[[:space:]]+stop|must[[:space:]]+complete|until[[:space:]]+done) ]]; then
	DETECTED_KEYWORDS+=("ralph")
	ADDITIONAL_CONTEXT+="[RALPH MODE DETECTED] Activate persistence mode - do not stop until verified complete. "
fi

if [[ "${PROMPT_LOWER}" =~ (ulw|ultrawork) ]]; then
	DETECTED_KEYWORDS+=("ultrawork")
	ADDITIONAL_CONTEXT+="[ULTRAWORK MODE DETECTED] Activate maximum parallel execution. "
fi

if [[ "${PROMPT_LOWER}" =~ (stop[[:space:]]+continuation|pause[[:space:]]+automation|take[[:space:]]+manual[[:space:]]+control) ]]; then
	DETECTED_KEYWORDS+=("stop-continuation")
	ADDITIONAL_CONTEXT+="[STOP CONTINUATION DETECTED] Halt all automated work — ralph and boulder state. "
fi

if [[ "${PROMPT_LOWER}" =~ ^(stop|cancel|abort)$ ]] || [[ "${PROMPT_LOWER}" =~ (^stop[[:space:]]|[[:space:]]stop$|^cancel[[:space:]]|[[:space:]]cancel$|^abort[[:space:]]|[[:space:]]abort$) ]]; then
	DETECTED_KEYWORDS+=("cancel")
	ADDITIONAL_CONTEXT+="[CANCEL DETECTED] User wants to stop current operation. Invoke cancel skill. "
fi

if [[ "${PROMPT_LOWER}" =~ (handoff|context[[:space:]]+is[[:space:]]+getting[[:space:]]+long|start[[:space:]]+fresh[[:space:]]+session) ]]; then
	DETECTED_KEYWORDS+=("handoff")
	ADDITIONAL_CONTEXT+="[HANDOFF MODE DETECTED] Create session handoff summary for new-session continuity. "
fi

if [[ "${PROMPT_LOWER}" =~ (setup[[:space:]]+omca|omca[[:space:]]+setup) ]]; then
	DETECTED_KEYWORDS+=("omca-setup")
	ADDITIONAL_CONTEXT+="[OMCA-SETUP DETECTED] Run /oh-my-claudeagent:omca-setup to configure the environment. "
fi

if [[ "${PROMPT_LOWER}" =~ (run[[:space:]]+atlas|atlas[[:space:]]+execute|atlas[[:space:]]+plan) ]]; then
	DETECTED_KEYWORDS+=("atlas")
	ADDITIONAL_CONTEXT+="[ATLAS DETECTED] Invoke /oh-my-claudeagent:atlas to execute work plans via the Atlas orchestrator. "
fi

if [[ "${PROMPT_LOWER}" =~ (run[[:space:]]+metis|metis[[:space:]]+analyze|pre-plan) ]]; then
	DETECTED_KEYWORDS+=("metis")
	ADDITIONAL_CONTEXT+="[METIS DETECTED] Invoke /oh-my-claudeagent:metis for pre-planning analysis. "
fi

if [[ "${PROMPT_LOWER}" =~ (run[[:space:]]+prometheus|prometheus[[:space:]]+plan|create[[:space:]]+plan) ]]; then
	DETECTED_KEYWORDS+=("prometheus-plan")
	ADDITIONAL_CONTEXT+="[PROMETHEUS DETECTED] Invoke /oh-my-claudeagent:prometheus-plan for strategic planning. "
fi

if [[ "${PROMPT_LOWER}" =~ (run[[:space:]]+hephaestus|hephaestus[[:space:]]+fix|fix[[:space:]]+build|build[[:space:]]+broken) ]]; then
	DETECTED_KEYWORDS+=("hephaestus")
	ADDITIONAL_CONTEXT+="[HEPHAESTUS DETECTED] Invoke /oh-my-claudeagent:hephaestus to fix build failures. "
fi

if [[ "${PROMPT_LOWER}" =~ (run[[:space:]]+sisyphus|sisyphus[[:space:]]+orchestrate|orchestrate[[:space:]]+this) ]]; then
	DETECTED_KEYWORDS+=("sisyphus-orchestrate")
	ADDITIONAL_CONTEXT+="[SISYPHUS DETECTED] Invoke /oh-my-claudeagent:sisyphus-orchestrate for master orchestration. "
fi

if [[ ${#DETECTED_KEYWORDS[@]} -gt 0 ]]; then
	PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
	STATE_FILE="${PROJECT_ROOT}/.omca/state/session.json"

	if [[ -f "${STATE_FILE}" ]]; then
		KEYWORDS_JSON=$(printf '%s\n' "${DETECTED_KEYWORDS[@]}" | jq -R . | jq -s . || true)
		TMP_FILE=$(mktemp)
		jq --argjson keywords "${KEYWORDS_JSON}" '.detectedKeywords = $keywords' "${STATE_FILE}" >"${TMP_FILE}" && mv "${TMP_FILE}" "${STATE_FILE}"
	fi
fi

if [[ -n "${ADDITIONAL_CONTEXT}" ]]; then
	ESCAPED_CONTEXT=$(echo "${ADDITIONAL_CONTEXT}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"UserPromptSubmit\", \"additionalContext\": ${ESCAPED_CONTEXT}}}"
else
	exit 0
fi
