#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

BOULDER_FILE="${STATE_DIR}/boulder.json"
MARKER_FILE="${STATE_DIR}/pending-final-verify.json"
EVIDENCE_FILE="${STATE_DIR}/verification-evidence.json"

# 3600s (1h) — F1-F4 freshness window. Matches final-verification-evidence.sh constant.
PC_MAX_EVIDENCE_AGE_SECONDS=3600

# Block compaction only when ALL THREE conditions hold: (1) boulder.active_plan
# is set, (2) pending-final-verify.json exists for the current session, and
# (3) fewer than 4 F1-F4 entries match the current plan SHA within the freshness
# window. Permissive by default — any condition absent → allow compaction.
ACTIVE_PLAN=$(jq_read "${BOULDER_FILE}" '.active_plan // ""')

if [[ -n "${ACTIVE_PLAN}" && -f "${MARKER_FILE}" ]]; then
	CURRENT_SID=$(resolve_session_id)
	MARKER_SID=$(jq_read "${MARKER_FILE}" '.session_id // ""')

	# Condition 2: marker session_id must match current session
	if [[ -n "${CURRENT_SID}" && -n "${MARKER_SID}" \
		&& "${MARKER_SID}" != "null" && "${MARKER_SID}" == "${CURRENT_SID}" ]]; then

		# Condition 3: count fresh F1-F4 entries for the current plan SHA
		CURRENT_SHA=""
		if [[ -f "${ACTIVE_PLAN}" ]]; then
			CURRENT_SHA=$(sha256sum "${ACTIVE_PLAN}" 2>/dev/null | awk '{print $1}' || true)
		fi

		PC_NOW=$(date +%s)
		PC_F_COUNT=0
		if [[ -f "${EVIDENCE_FILE}" ]]; then
			PC_F_COUNT=$(jq --argjson now "${PC_NOW}" \
				--argjson window "${PC_MAX_EVIDENCE_AGE_SECONDS}" \
				--arg sha "${CURRENT_SHA}" '
				.entries // []
				| map(select(
					(.type | test("^final_verification_f[1-4]$"))
					and (
						($now - ((.timestamp // "1970-01-01T00:00:00Z")
							| strptime("%Y-%m-%dT%H:%M:%SZ") | mktime))
						<= $window
					)
					and (
						($sha == "")
						or (.plan_sha256 == $sha)
						or ((.output_snippet // "") | test("plan_sha256:" + $sha))
					)
				))
				| length
			' "${EVIDENCE_FILE}" 2>/dev/null || echo "0")
		fi
		PC_F_COUNT="${PC_F_COUNT:-0}"

		if [[ "${PC_F_COUNT}" -lt 4 ]]; then
			printf '{"decision":"block","reason":"F1-F4 evidence pending; compact after evidence_log calls land."}\n'
			exit 0
		fi
	fi
fi

CONTEXT_FILE="${STATE_DIR}/compaction-context.md"
TMP_CONTEXT="${STATE_DIR}/compaction-context.tmp.$$"

{
	cat <<'TEMPLATE'
# Post-Compaction Context

## Active Mode
TEMPLATE

	if mode_is_active "ralph" "${STATE_DIR}"; then
		printf '%s\n' "Ralph mode is ACTIVE. The boulder never stops. Continue working on incomplete tasks."
		BOULDER_FILE="${STATE_DIR}/boulder.json"
		if [[ -f "${BOULDER_FILE}" ]]; then
			printf '\n## Active Plan Reference\n'
			jq_read "${BOULDER_FILE}" '.active_plan // "No plan file"'
		fi
	fi

	if mode_is_active "ultrawork" "${STATE_DIR}"; then
		printf '%s\n' "Ultrawork mode is ACTIVE. Continue parallel work."
	fi

	SUBAGENT_LOG="${LOG_DIR}/subagents.jsonl"
	ACTIVE_AGENTS=""
	if [[ -f "${SUBAGENT_LOG}" ]]; then
		ACTIVE_AGENTS=$(grep '"subagent_spawn"' "${SUBAGENT_LOG}" | tail -200 | jq -s '[.[] | select(.event == "subagent_spawn")] | .[-10:] | .[] | "- Agent: \(.type // "unknown"), SpawnID: \(.id // "unknown"), Model: \(.model // "default")"' 2>/dev/null | tr -d '"')
	fi

	printf '\n## Recently Spawned Agents\n'
	if [[ -n "${ACTIVE_AGENTS}" ]]; then
		printf '%s\n' "${ACTIVE_AGENTS}"
	else
		printf '%s\n' "No recent agent spawns recorded."
	fi
	printf '%s\n' "RESUME, DON'T RESTART: If an agent was working on a task before compaction, resume it with SendMessage({to: \"<agentId>\"}) rather than spawning a new one. Check subagent completion status before re-delegating."

	printf '\n## Pending Tasks\n'
	printf '%s\n' "Check boulder.json for active plan and remaining tasks."

	NOTEPADS_DIR="${STATE_DIR}/notepads"
	if [[ -d "${NOTEPADS_DIR}" ]]; then
		printf '\n## Notepad Summaries\n'
		for PLAN_DIR in "${NOTEPADS_DIR}"/*/; do
			PLAN_NAME=$(basename "${PLAN_DIR}")
			printf '### Plan: %s\n' "${PLAN_NAME}"
			for SECTION_FILE in "${PLAN_DIR}"*.md; do
				[[ -f "${SECTION_FILE}" ]] || continue
				SECTION_NAME=$(basename "${SECTION_FILE}" .md)
				LINE_COUNT=$(wc -l <"${SECTION_FILE}")
				printf '- %s: %s lines\n' "${SECTION_NAME}" "${LINE_COUNT}"
			done
		done
	fi

	if [[ -f "${EVIDENCE_FILE}" ]]; then
		printf '\n## Latest Verification Evidence\n'
		LATEST=$(jq -r '.entries | last | "type=\(.type) cmd=\(.command) exit=\(.exit_code) ts=\(.timestamp)"' "${EVIDENCE_FILE}")
		if [[ -n "${LATEST}" ]]; then
			printf '%s\n' "${LATEST}"
		else
			printf '%s\n' "No evidence entries."
		fi
	fi
} >"${TMP_CONTEXT}"

if ! mv "${TMP_CONTEXT}" "${CONTEXT_FILE}" 2>/dev/null; then
	rm -f "${TMP_CONTEXT}"
fi

exit 0
