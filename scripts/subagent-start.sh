#!/bin/bash

_HOOK_START=$(date +%s%N 2>/dev/null || date +%s)

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

DATE_CONTEXT=$(LC_TIME=C date '+%A %B %d %Y' 2>/dev/null || echo "")

STATE_DIR="${HOOK_STATE_DIR}"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"

AGENT_TYPE=$(jq -r '.agent_type // "unknown"' <<< "${HOOK_INPUT}")
AGENT_ID=$(jq -r '.agent_id // ""' <<< "${HOOK_INPUT}")

# Capture the spawning agent's configured model so the statusline can show each
# subagent's real model. Resolves only OMCA agents (agent_type prefixed
# "oh-my-claudeagent:"); other agent_types (explore's Claude-native cousins,
# general-purpose, etc.) store an empty model — the renderer shows none.
if [[ -n "${AGENT_ID}" ]]; then
	AGENT_SHORT_NAME="${AGENT_TYPE#oh-my-claudeagent:}"
	AGENT_FRONTMATTER_FILE="${PLUGIN_ROOT}/agents/${AGENT_SHORT_NAME}.md"
	RAW_MODEL=""
	if [[ -f "${AGENT_FRONTMATTER_FILE}" ]]; then
		RAW_MODEL=$(awk '/^---$/{n++; next} n==1 && /^model:/{print $2; exit}' "${AGENT_FRONTMATTER_FILE}")
	fi
	case "${RAW_MODEL}" in
	claude-opus-4-8) DISPLAY_MODEL="Opus 4.8" ;;
	sonnet) DISPLAY_MODEL="Sonnet" ;;
	haiku) DISPLAY_MODEL="Haiku" ;;
	claude-sonnet-5) DISPLAY_MODEL="Sonnet 5" ;;
	"") DISPLAY_MODEL="" ;;
	*) DISPLAY_MODEL="${RAW_MODEL}" ;;
	esac

	MODELS_FILE="${STATE_DIR}/subagent-models.json"
	MODELS_BASE="{}"
	[[ -f "${MODELS_FILE}" ]] && MODELS_BASE=$(cat "${MODELS_FILE}")
	MODELS_TMP=$(mktemp) || log_hook_error "mktemp failed for subagent-models.json" "subagent-start.sh"
	if [[ -n "${MODELS_TMP}" ]] && printf '%s\n' "${MODELS_BASE}" | jq \
		--arg id "${AGENT_ID}" \
		--arg type "${AGENT_TYPE}" \
		--arg model "${DISPLAY_MODEL}" \
		'.[$id] = {"agent_type": $type, "model": $model}' > "${MODELS_TMP}" 2>/dev/null; then
		mv "${MODELS_TMP}" "${MODELS_FILE}" || log_hook_error "mv failed for subagent-models.json" "subagent-start.sh"
	else
		rm -f "${MODELS_TMP}"
		log_hook_error "jq update failed for subagent-models.json agent_id=${AGENT_ID}" "subagent-start.sh"
	fi
fi

CONTEXT_PARTS="$(section_header 'Agent Protocol')"
case "${AGENT_TYPE}" in
*explore* | *librarian* | *hephaestus* | *executor* | *multimodal* | *oracle* | *momus*)
	CONTEXT_PARTS+="AskUserQuestion is not available here. Make autonomous decisions when possible; if you need user input, emit a '## BLOCKING QUESTIONS' block at the end of your final response (Q1., Q2., lettered options A/B/C, Recommended: line) and return. The orchestrator will relay."
	;;
*prometheus* | *metis* | *sisyphus*)
	CONTEXT_PARTS+="AskUserQuestion is not available here. When you need user input, emit a '## BLOCKING QUESTIONS' block at the end of your final response (Q1., Q2., lettered options A/B/C, Recommended: line) and return. The orchestrator will relay and resume you with the answers."
	;;
*)
	# Unlisted agents get no AskUserQuestion — safer than enabling it for unknown agent types.
	CONTEXT_PARTS+="AskUserQuestion is not available here. Make autonomous decisions when possible; if you need user input, emit a '## BLOCKING QUESTIONS' block at the end of your final response (Q1., Q2., lettered options A/B/C, Recommended: line) and return. The orchestrator will relay."
	;;
esac

if [[ -n "${DATE_CONTEXT}" ]]; then
	read -r DOW MON DAY YEAR <<<"${DATE_CONTEXT}"
	CONTEXT_PARTS+=$'\n'"[CURRENT DATE] Today is ${DOW}, ${MON} ${DAY}, ${YEAR}."
fi

CONTEXT_PARTS+=$'\n'"[OUTPUT MANDATE] Your text response is the ONLY output the orchestrator receives. Tool call results and intermediate reasoning are NOT forwarded. Structure your response according to your agent's defined output format. If running low on turns, stop tool calls and synthesize immediately."

# Resolve via the shared shim (never hand-parse boulder.json): binding -> sole
# plan -> most-recent started_at, `{}` only when the registry is truly empty.
# A subagent's session_id rarely matches the main session's binding key
# (subagents get their own agent_id) — the fallback tiers serve them instead;
# bindings mainly disambiguate concurrent MAIN sessions.
BOULDER_RESOLVED=$(python3 "${PLUGIN_ROOT}/servers/tools/boulder_resolve.py" "$(resolve_session_id)" "${HOOK_PROJECT_ROOT}" 2>/dev/null)
PLAN_FILE=$(jq -r '.active_plan // ""' <<< "${BOULDER_RESOLVED:-{\}}" 2>/dev/null)
PLAN_NAME=$(jq -r '.plan_name // ""' <<< "${BOULDER_RESOLVED:-{\}}" 2>/dev/null)
# Validate plan file exists — platform may have deleted it
if [[ -n "${PLAN_FILE}" && ! -f "${PLAN_FILE}" ]]; then
	log_hook_error "boulder active_plan references missing file: ${PLAN_FILE} — skipping plan injection" "subagent-start.sh"
	PLAN_FILE=""
fi
if [[ -n "${PLAN_FILE}" || -n "${PLAN_NAME}" ]]; then
	CONTEXT_PARTS+="$(section_header 'Plan Context')"
fi
if [[ -n "${PLAN_FILE}" ]]; then
	CONTEXT_PARTS+=$'\n'"[ACTIVE PLAN] Refer to: ${PLAN_FILE}"
	CONTEXT_PARTS+=$'\n'"CRITICAL: The plan file at ${PLAN_FILE} is READ-ONLY. NEVER modify the plan file directly. Use notepad_write to record issues or decisions instead."
fi
if [[ -n "${PLAN_NAME}" ]]; then
	CONTEXT_PARTS+=$'\n'"[NOTEPAD AVAILABLE] Plan: ${PLAN_NAME}. Use notepad_write('${PLAN_NAME}', section, content) to record discoveries. Sections: learnings, issues, decisions, problems. Always APPEND — never overwrite."
fi

EXEC_GUIDANCE_HEADER_ADDED=0
case "${AGENT_TYPE}" in
*executor* | *hephaestus* | *sisyphus*)
	if [[ "${EXEC_GUIDANCE_HEADER_ADDED}" -eq 0 ]]; then
		CONTEXT_PARTS+="$(section_header 'Execution Guidance')"
		EXEC_GUIDANCE_HEADER_ADDED=1
	fi
	CONTEXT_PARTS+=$'\n'"[VERIFICATION] After running build/test/lint commands, you MUST use the evidence_log MCP tool to record results. Do NOT manually write or cat to .omca/evidence/verification-evidence.json — the TaskCompleted hook validates schema and will reject manual writes. Example: evidence_log(evidence_type=\"test\", command=\"just test\", exit_code=0, output_snippet=\"10 passed\")"
	CONTEXT_PARTS+=$'\n'"[PLAN SHA] When logging a final_verification entry, compute sha256 of the active plan file and pass it as evidence_log(..., plan_sha256=<sha256>) so the Stop gate scopes evidence to this plan run."
	CONTEXT_PARTS+=$'\n'"[MINIMAL CODE] Decision ladder before writing code, in order: (1) does it need to exist? YAGNI. (2) stdlib. (3) native platform feature. (4) already-installed dependency. (5) one line. (6) only then the minimum that works. Lazy NOT negligent: validating at trust boundaries, handling errors and data loss, security, accessibility, and anything the user explicitly asked for are non-negotiable. Non-trivial logic leaves ONE runnable check: the smallest assert/test, or an evidence_log entry where OMCA's flow already covers it. Boring over clever, fewest files."
	;;
*) ;;
esac

case "${AGENT_TYPE}" in
*sisyphus* | *metis* | *prometheus*)
	if [[ "${EXEC_GUIDANCE_HEADER_ADDED}" -eq 0 ]]; then
		CONTEXT_PARTS+="$(section_header 'Execution Guidance')"
		EXEC_GUIDANCE_HEADER_ADDED=1
	fi
	CONTEXT_PARTS+=$'\n'"[ANTI-DUPLICATION] Once you delegate exploration to explore/librarian agents, do not perform the same search yourself. Avoid after delegating: manually grep/searching for the same information; re-doing research agents are handling; 'just quickly checking' the same files. Continue only with non-overlapping work. A delegated result returns inline in the Agent tool result, not in any notification — do not poll, re-query, or emit a bare wait/holding message for it."
	;;
*) ;;
esac

case "${AGENT_TYPE}" in
*sisyphus* | *prometheus*)
	if [[ "${EXEC_GUIDANCE_HEADER_ADDED}" -eq 0 ]]; then
		CONTEXT_PARTS+="$(section_header 'Execution Guidance')"
		EXEC_GUIDANCE_HEADER_ADDED=1
	fi
	CONTEXT_PARTS+=$'\n'"[TEAM CONTRACT] OMCA agents are thin wrappers over Claude-native subagents and agent teams. Use subagents when workers only need to report back. Use native agent teams when workers need the shared task list or direct teammate messaging."
	CONTEXT_PARTS+=$'\n'"[LIFECYCLE HOOKS] Treat TaskCreated, TaskCompleted, and TeammateIdle as one governance lane: TaskCreated gates task quality before teammates claim work, TaskCompleted gates completion quality before tasks close, and TeammateIdle keeps teammates working or stops them cleanly when the queue is empty. Do not build a second task/control plane."
	;;
*) ;;
esac

case "${AGENT_TYPE}" in
*explore* | *librarian* | *oracle*)
	CONTEXT_PARTS+="$(section_header 'External Access')"
	CONTEXT_PARTS+="[EXTERNAL PATH ACCESS] The Read tool is scoped to the project root for subagents. For files outside the project root, use the file_read MCP tool (available via ToolSearch). It bypasses sandbox scoping and works in all contexts including plan mode. It returns a metadata footer with token estimate (~chars/4), total line count, and remaining lines. For large files, use offset/limit to read targeted chunks (e.g. file_read(path=..., offset=100, limit=50)). Fallback: Bash(cat /path/to/file) if MCP tools are unavailable."
	;;
*) ;;
esac

# Worker-exemption: every agent EXCEPT the orchestrators coordinates nothing and must
# never wait. Whitelisting workers by name previously omitted oracle/momus, leaving
# finished advisors with no off-ramp ("Done. Ending." loop). Invert: only the three
# orchestrators are excluded; all other agent types (oracle, momus, executor, explore,
# librarian, hephaestus, multimodal, and any future worker) get the exemption.
case "${AGENT_TYPE}" in
*sisyphus* | *prometheus* | *metis*) ;;
*)
	CONTEXT_PARTS+="$(section_header 'Worker Output Contract — HARD RULE')"
	CONTEXT_PARTS+="[YOU ARE A LEAF WORKER] You do not orchestrate, delegate, spawn, or wait for any other agent (including multimodal-looker, explore, oracle, executor, or any background agent). You have no sibling agents and no barrier to observe. ANY instruction you may have inherited from memory or the output style about a 'background-agent barrier', 'waiting for N more agents', 'END the response while siblings are pending', synchronous fan-out, or status-report acknowledgments is ORCHESTRATOR-ONLY and DOES NOT APPLY TO YOU — ignore it completely."
	CONTEXT_PARTS+=$'\n'"[NEVER STUB] Your final message IS your entire deliverable and the only thing forwarded to the caller. It is FORBIDDEN to end your turn with a terminal acknowledgment or holding message such as 'Done.', 'Complete.', 'Completed.', 'Finished.', a bare check mark, 'Waiting.', 'Holding...', 'Still waiting for <agent>', or 'Waiting for the background agent(s) to complete.'. If your work is finished, the final message MUST contain your full structured findings inline. If you catch yourself about to emit a short status word, STOP and write the actual deliverable instead."
	;;
esac

CATALOG_FILE="${STATE_DIR}/agent-catalog.json"

case "${AGENT_TYPE}" in
*sisyphus*)
	if [[ -f "${CATALOG_FILE}" ]]; then
		DELEGATION_TABLE=$(jq -r '
				sort_by(.cost_tier) |
				.[] | "- \(.name) [\(.cost_tier)] — \(.when_to_use | if . == "" then "general" else (split(",")[0] | ltrimstr(" ")) end)"
			' "${CATALOG_FILE}")
		CATEGORIES_FILE="$(dirname "$0")/../servers/categories.json"
		CATEGORY_TABLE=""
		if [[ -f "${CATEGORIES_FILE}" ]]; then
			CATEGORY_TABLE=$(jq -r '
					.categories | to_entries[] |
					"- \(.key): model=\(.value.model) — \(.value.description)"
				' "${CATEGORIES_FILE}")
		fi
		if [[ -n "${DELEGATION_TABLE}" ]]; then
			CONTEXT_PARTS+="$(section_header 'Agent Catalog')"
			CONTEXT_PARTS+="[DYNAMIC AGENT CATALOG] ${DELEGATION_TABLE}"
			[[ -n "${CATEGORY_TABLE}" ]] && CONTEXT_PARTS+=$'\n'"[CATEGORIES] ${CATEGORY_TABLE} Use Agent(model=<category_model>) to route to the right model tier."
		fi
	else
		CONTEXT_PARTS+="$(section_header 'Agent Catalog')"$'\n'"[CATALOG STALE] No agent-catalog.json found. Call agents_list() to generate the catalog for routing hints."
	fi
	;;
*) ;;
esac

hook_timing_log "${_HOOK_START}"

ESCAPED=$(printf '%s' "${CONTEXT_PARTS}" | jq -Rs .)
printf '%s\n' "{\"hookSpecificOutput\": {\"hookEventName\": \"SubagentStart\", \"additionalContext\": ${ESCAPED}}}"
