#!/bin/bash
# PostToolBatch handler: same-file concurrent-edit warning (signal-a) and
# batch-consolidated delegation reminder (signal-b, main session only).
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

# --------------------------------------------------------------------------
# Early-exit: subagent sessions never count or remind (executors cannot
# spawn agents); same-file conflict warning still fires even in subagents.
# --------------------------------------------------------------------------
AGENT_ID=$(jq -r '.agent_id // ""' <<< "${HOOK_INPUT}" 2>/dev/null)
IS_SUBAGENT=false
[[ -n "${AGENT_ID}" ]] && IS_SUBAGENT=true

# Extract tool names and file paths in one jq pass.
read -r SEARCH_HIT CONFLICT_PATHS < <(jq -rn \
	--argjson input "${HOOK_INPUT}" \
	'
	  ($input.tool_calls // []) as $tc |
	  # Signal-b: any search tools?
	  ([$tc[] | select(.tool_name | IN("Grep","Glob","WebFetch","WebSearch"))] | length > 0) as $has_search |
	  # Signal-a: file paths for write-family tools
	  [$tc[] | select(.tool_name | IN("Write","Edit","NotebookEdit")) | .tool_input.file_path // ""] as $paths |
	  ($paths | group_by(.) | map(select(length > 1 and .[0] != "")) | map(.[0])) as $dupes |
	  [$has_search, ($dupes | join(","))] | @tsv
	' 2>/dev/null || echo "false	")

# Nothing to do: no search tools (signal-b skipped or subagent) and no conflicts (signal-a)
if [[ "${SEARCH_HIT}" == "false" && -z "${CONFLICT_PATHS}" ]]; then
	exit 0
fi

OUTPUT=""

# --------------------------------------------------------------------------
# Signal-a: concurrent same-file edit warning (fires in all sessions)
# --------------------------------------------------------------------------
if [[ -n "${CONFLICT_PATHS}" ]]; then
	IFS=',' read -ra DUPE_ARR <<< "${CONFLICT_PATHS}"
	PATH_LIST=$(printf '  %s\n' "${DUPE_ARR[@]}")
	OUTPUT+="[CONCURRENT EDIT WARNING] Multiple write operations target the same file in this batch — last write wins and earlier changes may be lost:
${PATH_LIST}
Sequence writes to the same file across separate turns."
fi

# --------------------------------------------------------------------------
# Signal-b: batch-consolidated delegation reminder (main session only)
# --------------------------------------------------------------------------
if [[ "${SEARCH_HIT}" == "true" && "${IS_SUBAGENT}" == "false" ]]; then
	ACTIVE_AGENTS="${STATE_DIR}/active-agents.json"
	SUBAGENTS_FILE="${STATE_DIR}/subagents.json"
	AGENT_COUNT=$(jq -rn \
		--argjson aa "$(jq -c '.' "${ACTIVE_AGENTS}" 2>/dev/null || echo '[]')" \
		--argjson sa "$(jq -c '.active // []' "${SUBAGENTS_FILE}" 2>/dev/null || echo '[]')" \
		'([$aa[].id] + [$sa[].id]) | unique | length')
	if [[ "${AGENT_COUNT}" -gt 0 ]]; then
		# Agents already running — no reminder
		true
	else
		USAGE_FILE="${STATE_DIR}/agent-usage.json"
		if [[ ! -f "${USAGE_FILE}" ]]; then
			echo '{"agentUsed": false, "toolCallCount": 0}' >"${USAGE_FILE}"
		fi

		AGENT_USED=$(jq_read "${USAGE_FILE}" '.agentUsed // false')
		if [[ "${AGENT_USED}" != "true" ]]; then
			TMP=$(mktemp)
			jq '.toolCallCount += 1' "${USAGE_FILE}" >"${TMP}" && mv "${TMP}" "${USAGE_FILE}"
			COUNT=$(jq_read "${USAGE_FILE}" '.toolCallCount // 0')
			COUNT="${COUNT:-0}"

			if [[ $((COUNT % 3)) -eq 0 ]]; then
				REMINDER="[DELEGATION REMINDER] You've made ${COUNT} direct search/fetch calls without delegating.
Available agents: explore (codebase search), librarian (docs research), hephaestus (build fixes), momus (plan review), oracle (architecture advice).
Relevant skills: /refactor, /git-master, /playwright, /frontend-ui-ux.
Use Agent(subagent_type=\"oh-my-claudeagent:NAME\", prompt=\"...\") to delegate."
				if [[ -n "${OUTPUT}" ]]; then
					OUTPUT+=$'\n\n'
				fi
				OUTPUT+="${REMINDER}"
			fi
		fi
	fi
fi

if [[ -n "${OUTPUT}" ]]; then
	emit_context "PostToolBatch" "${OUTPUT}"
else
	exit 0
fi
