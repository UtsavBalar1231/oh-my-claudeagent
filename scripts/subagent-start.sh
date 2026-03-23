#!/bin/bash

_HOOK_START=$(date +%s%N 2>/dev/null || date +%s)

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"
STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

AGENT_ID=$(echo "${INPUT}" | jq -r '.agent_id // "unknown"')

AGENT_TYPE=$(echo "${INPUT}" | jq -r '.agent_type // "unknown"')

case "${AGENT_TYPE}" in
	*explore*|*librarian*|*hephaestus*|*sisyphus-junior*|*multimodal*|*oracle*|*momus*)
		CONTEXT_PARTS="AskUserQuestion is unavailable in subagents. Make autonomous decisions when possible. If genuinely blocked, write the question to the notepad questions section and return."
		;;
	*prometheus*|*metis*|*socrates*|*sisyphus*|*atlas*)
		CONTEXT_PARTS="AskUserQuestion is unavailable in subagents. When you need user input, write the question to the notepad questions section and return. The orchestrator will relay to the user and resume you."
		;;
	*)
		CONTEXT_PARTS="Make autonomous decisions. If unclear, choose the most reasonable option and proceed."
		;;
esac

CONTEXT_PARTS+=" [OUTPUT MANDATE] Your text response is the ONLY output the orchestrator receives. Tool call results and intermediate reasoning are NOT forwarded. Structure your response as: 1. CRITICAL FACTS: Key findings, decisions, or results (bullet points) 2. DETAILS: Supporting context if needed Target length: 1,000-2,000 tokens. If running low on turns, stop tool calls and synthesize immediately."

for MODE_FILE in ralph-state.json ultrawork-state.json; do
	if [[ -f "${STATE_DIR}/${MODE_FILE}" ]]; then
		MODE_STATUS=$(jq -r '.status // "inactive"' "${STATE_DIR}/${MODE_FILE}" 2>/dev/null)
		if [[ "${MODE_STATUS}" == "active" ]]; then
			MODE_NAME="${MODE_FILE%-state.json}"
			CONTEXT_PARTS+=" [${MODE_NAME^^} MODE ACTIVE] Continue working in ${MODE_NAME} mode."
		fi
	fi
done

BOULDER_FILE="${STATE_DIR}/boulder.json"
if [[ -f "${BOULDER_FILE}" ]]; then
	PLAN_FILE=$(jq -r '.active_plan // empty' "${BOULDER_FILE}" 2>/dev/null || echo "")
	PLAN_NAME=$(jq -r '.plan_name // empty' "${BOULDER_FILE}" 2>/dev/null || echo "")
	if [[ -n "${PLAN_FILE}" ]]; then
		CONTEXT_PARTS+=" [ACTIVE PLAN] Refer to: ${PLAN_FILE}"
		CONTEXT_PARTS+=" CRITICAL: The plan file at ${PLAN_FILE} is READ-ONLY. NEVER modify the plan file directly. Use notepad_write to record issues or decisions instead."
	fi
	if [[ -n "${PLAN_NAME}" ]]; then
		CONTEXT_PARTS+=" [NOTEPAD AVAILABLE] Plan: ${PLAN_NAME}. Use notepad_write('${PLAN_NAME}', section, content) to record discoveries. Sections: learnings, issues, decisions, problems, questions. Use 'questions' when you need user input (AskUserQuestion is unavailable in subagents). Always APPEND — never overwrite."
	fi
fi

# Inject evidence_log guidance for execution agents
case "${AGENT_TYPE}" in
	*sisyphus-junior*|*hephaestus*|*atlas*|*sisyphus*)
		CONTEXT_PARTS+=" [VERIFICATION] After running build/test/lint commands, you MUST use the evidence_log MCP tool to record results. Do NOT manually write or cat to .omca/state/verification-evidence.json — the TaskCompleted hook validates schema and will reject manual writes. Example: evidence_log(evidence_type=\"test\", command=\"just test\", exit_code=0, output_snippet=\"10 passed\")"
		;;
	*) ;;
esac

# Inject anti-duplication rule for orchestrator agents
case "${AGENT_TYPE}" in
	*sisyphus*|*atlas*|*metis*|*prometheus*)
		CONTEXT_PARTS+=" [ANTI-DUPLICATION] Once you delegate exploration to explore/librarian agents, do not perform the same search yourself. Avoid after delegating: manually grep/searching for the same information; re-doing research agents are handling; 'just quickly checking' the same files. Continue only with non-overlapping work. When delegated results are needed but not ready: end your response and wait for the completion notification — do not re-search the same topics while waiting."
		;;
	*) ;;
esac

# Inject external directory access guidance for plan-mode agents
case "${AGENT_TYPE}" in
	*explore*|*librarian*|*oracle*)
		CONTEXT_PARTS+=" [EXTERNAL PATH ACCESS] You are in plan mode and cannot use Read for files outside the project root. When you need to read external files (e.g. documentation repos, system configs), use Bash(cat /path/to/file) instead of Read(/path/to/file). This is a platform limitation — additionalDirectories does not propagate to subagents."
		;;
	*) ;;
esac

# --- Concurrency registration (atomic read-modify-write) ---
ACTIVE_FILE="${STATE_DIR}/active-agents.json"
CATALOG_FILE="${STATE_DIR}/agent-catalog.json"

AGENT_MODEL="sonnet"
if [[ -f "${CATALOG_FILE}" ]]; then
	AGENT_NAME=$(echo "${AGENT_TYPE##*:}" | tr '[:upper:]' '[:lower:]')
	CATALOG_MODEL=$(jq -r --arg name "${AGENT_NAME}" \
		'.[] | select(.name == $name) | .default_model // "sonnet"' \
		"${CATALOG_FILE}" 2>/dev/null)
	[[ -n "${CATALOG_MODEL}" ]] && AGENT_MODEL="${CATALOG_MODEL}"
fi

# Register — atomic mktemp+mv (no flock — POSIX portable)
ACTIVE=$(cat "${ACTIVE_FILE}" 2>/dev/null || echo '[]')
STARTED_EPOCH=$(date +%s)
TMP_ACTIVE=$(mktemp)
echo "${ACTIVE}" | jq --arg id "${AGENT_ID}" --arg agent "${AGENT_TYPE}" \
	--arg model "${AGENT_MODEL}" --arg ts "$(date -Iseconds)" --argjson epoch "${STARTED_EPOCH}" \
	'. += [{"id": $id, "agent": $agent, "model": $model, "started": $ts, "started_epoch": $epoch}]' \
	>"${TMP_ACTIVE}" && mv "${TMP_ACTIVE}" "${ACTIVE_FILE}"

# Bridge spawn-ID to platform agent_id in subagents.json
SUBAGENTS_FILE="${STATE_DIR}/subagents.json"
if [[ -f "${SUBAGENTS_FILE}" ]]; then
	AGENT_TYPE_SHORT="${AGENT_TYPE##*:}"  # strip "oh-my-claudeagent:" prefix
	TMP_SUB=$(mktemp)
	jq --arg platform_id "${AGENT_ID}" \
	   --arg agent_type "${AGENT_TYPE_SHORT}" \
	   --argjson epoch "$(date +%s)" \
	   '
	   # Find first .active[] entry with spawn-* ID matching this agent type
	   (.active | to_entries | map(select(
	       .value.id | startswith("spawn-")
	   )) | map(select(
	       .value.type == $agent_type or .value.type == ("oh-my-claudeagent:" + $agent_type)
	   )) | .[0]) as $match |
	   if $match != null then
	       .active[$match.key].id = $platform_id |
	       .active[$match.key].started_epoch = $epoch
	   else . end
	   ' "${SUBAGENTS_FILE}" > "${TMP_SUB}" && mv "${TMP_SUB}" "${SUBAGENTS_FILE}"
fi

# --- Catalog injection for orchestrators ---
case "${AGENT_TYPE}" in
	*sisyphus*|*atlas*)
		if [[ -f "${CATALOG_FILE}" ]]; then
			DELEGATION_TABLE=$(jq -r '
				sort_by(.cost_tier) |
				.[] | "- \(.name) [\(.cost_tier)] — \(.when_to_use | if . == "" then "general" else (split(",")[0] | ltrimstr(" ")) end)"
			' "${CATALOG_FILE}" 2>/dev/null || echo "")
			CATEGORIES_FILE="$(dirname "$0")/../servers/categories.json"
			CATEGORY_TABLE=""
			if [[ -f "${CATEGORIES_FILE}" ]]; then
				CATEGORY_TABLE=$(jq -r '
					.categories | to_entries[] |
					"- \(.key): model=\(.value.model) — \(.value.description)"
				' "${CATEGORIES_FILE}" 2>/dev/null || echo "")
			fi
			if [[ -n "${DELEGATION_TABLE}" ]]; then
				CONTEXT_PARTS+=" [DYNAMIC AGENT CATALOG] ${DELEGATION_TABLE}"
				[[ -n "${CATEGORY_TABLE}" ]] && CONTEXT_PARTS+=" [CATEGORIES] ${CATEGORY_TABLE} Use Agent(model=<category_model>) to route to the right model tier."
			fi
		else
			_log_hook_error "agent-catalog.json missing — catalog stale for agent ${AGENT_TYPE}" "subagent-start.sh"
			CONTEXT_PARTS+=" [CATALOG STALE] No agent-catalog.json found. Call agents_list() to generate the catalog for routing hints."
		fi
		;;
	*) ;;
esac

_HOOK_END=$(date +%s%N 2>/dev/null || date +%s)
_HOOK_MS=$(( (_HOOK_END - _HOOK_START) / 1000000 ))
echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"hook\":\"$(basename "$0")\",\"ms\":${_HOOK_MS}}" >> "${LOG_DIR}/hook-timing.jsonl" 2>/dev/null

ESCAPED=$(printf '%s' "${CONTEXT_PARTS}" | jq -Rs .)
printf '%s\n' "{\"hookSpecificOutput\": {\"hookEventName\": \"SubagentStart\", \"additionalContext\": ${ESCAPED}}}"
