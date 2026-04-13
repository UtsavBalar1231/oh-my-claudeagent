#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"
STATE_DIR="${HOOK_STATE_DIR}"

# Plan-file-aware stagnation: track mtime + checkbox counts alongside task-hash signal.
# Only runs when RALPH_ACTIVE=true and boulder has a fresh active_plan.
# Updates plan_stagnation_count in ralph-state.json; escalates when >= 3 by logging
# and feeding into the existing stagnation-allows-stop path (check_boulder_fallback → exit 0).
# NOTE: exits the script (not just the function) when escalation threshold is reached.
check_plan_file_progress() {
	local boulder_file="${STATE_DIR}/boulder.json"
	if [[ ! -f "${boulder_file}" ]]; then
		return 0
	fi

	local active_plan
	active_plan=$(jq -r '.active_plan // ""' "${boulder_file}" 2>/dev/null)
	if [[ -z "${active_plan}" || "${active_plan}" == "null" ]]; then
		return 0
	fi

	# Resolve plan path: support both absolute and relative (relative to project root)
	local plan_file="${active_plan}"
	if [[ ! -f "${plan_file}" ]]; then
		# Try relative to CLAUDE_PROJECT_ROOT if set
		local project_root="${CLAUDE_PROJECT_ROOT:-}"
		if [[ -n "${project_root}" && -f "${project_root}/${active_plan}" ]]; then
			plan_file="${project_root}/${active_plan}"
		else
			return 0
		fi
	fi

	# Read current plan file mtime (portable: GNU stat then BSD stat)
	local plan_mtime
	plan_mtime=$(stat -c %Y "${plan_file}" 2>/dev/null || stat -f %m "${plan_file}" 2>/dev/null || echo "")
	if [[ -z "${plan_mtime}" ]]; then
		return 0
	fi

	# Count incomplete and complete checkboxes
	local incomplete complete
	incomplete=$(grep -c '^- \[ \] ' "${plan_file}" 2>/dev/null || true)
	complete=$(grep -c '^- \[x\] ' "${plan_file}" 2>/dev/null || true)
	incomplete="${incomplete:-0}"
	complete="${complete:-0}"

	# Read previous values from ralph-state.json
	local last_mtime plan_stagnation
	last_mtime=$(jq -r '.last_plan_mtime // ""' "${RALPH_STATE}" 2>/dev/null)
	plan_stagnation=$(jq -r '.plan_stagnation_count // 0' "${RALPH_STATE}" 2>/dev/null)
	last_mtime="${last_mtime:-}"
	plan_stagnation="${plan_stagnation:-0}"

	# Detect plan-level stagnation: mtime unchanged AND incomplete count > 0 AND
	# task-hash also unchanged (STAGNATION > 0 means hash matched at least once)
	if [[ "${incomplete}" -gt 0 && "${plan_mtime}" == "${last_mtime}" && "${STAGNATION}" -gt 0 ]]; then
		plan_stagnation=$((plan_stagnation + 1))
	else
		plan_stagnation=0
	fi

	# Update ralph-state.json with plan tracking fields atomically
	jq --arg mtime "${plan_mtime}" \
		--argjson inc "${incomplete}" \
		--argjson com "${complete}" \
		--argjson psc "${plan_stagnation}" \
		'.last_plan_mtime = $mtime | .last_plan_incomplete = $inc | .last_plan_complete = $com | .plan_stagnation_count = $psc' \
		"${RALPH_STATE}" > "${RALPH_STATE}.tmp" && \
		mv "${RALPH_STATE}.tmp" "${RALPH_STATE}"

	if [[ ${plan_stagnation} -ge 3 ]]; then
		_log_hook_error "ralph plan stagnated (plan_stagnation_count=${plan_stagnation}, incomplete=${incomplete}) — allowing stop" "ralph-persistence.sh"
		# Feed into existing stagnation-allows-stop path
		check_boulder_fallback
		exit 0
	fi
}

# Boulder fallback: block stop if a fresh work plan exists
# NOTE: exit 0 here exits the script, not just the function
check_boulder_fallback() {
	local boulder_file="${STATE_DIR}/boulder.json"
	if [[ -f "${boulder_file}" ]]; then
		local active_plan
		active_plan=$(jq -r '.active_plan // ""' "${boulder_file}" 2>/dev/null)
		if [[ -n "${active_plan}" && "${active_plan}" != "null" ]]; then
			if command -v stat &>/dev/null; then
				local boulder_mtime boulder_age
				boulder_mtime=$(stat -c %Y "${boulder_file}" 2>/dev/null || stat -f %m "${boulder_file}" 2>/dev/null || echo 0)
				boulder_age=$(( $(date +%s) - boulder_mtime ))
				if [[ ${boulder_age} -lt 900 ]]; then
					echo '{"decision":"block","reason":"[PERSISTENCE] Active work plan detected via boulder. Continue working on tasks."}'
					exit 0
				fi
			fi
		fi
	fi
}

# Recursion guard — stop_hook_active prevents infinite Stop hook loops
STOP_HOOK_ACTIVE=$(echo "${INPUT}" | jq -r '.stop_hook_active // false' 2>/dev/null)
if [[ "${STOP_HOOK_ACTIVE}" == "true" ]]; then
	exit 0
fi

# Unified mode detection
RALPH_STATE="${STATE_DIR}/ralph-state.json"
ULTRAWORK_STATE="${STATE_DIR}/ultrawork-state.json"

RALPH_ACTIVE=false
ULTRAWORK_ACTIVE=false

if [[ -f "${RALPH_STATE}" ]]; then
	STATUS=$(jq -r '.status // "inactive"' "${RALPH_STATE}" 2>/dev/null)
	[[ "${STATUS}" == "active" ]] && RALPH_ACTIVE=true
fi

if [[ -f "${ULTRAWORK_STATE}" ]]; then
	STATUS=$(jq -r '.status // "inactive"' "${ULTRAWORK_STATE}" 2>/dev/null)
	[[ "${STATUS}" == "active" ]] && ULTRAWORK_ACTIVE=true
fi

if [[ "${RALPH_ACTIVE}" != "true" && "${ULTRAWORK_ACTIVE}" != "true" ]]; then
	exit 0  # No persistence mode active
fi

# Allow stop if a question is pending — user needs to answer
QUESTION_FILE="${STATE_DIR}/pending-question.json"
if [[ -f "${QUESTION_FILE}" ]]; then
	Q_TS=$(jq -r '.timestamp // 0' "${QUESTION_FILE}" 2>/dev/null)
	Q_TS=${Q_TS:-0}
	NOW=$(date +%s)
	DIFF=$((NOW - Q_TS))
	if [[ ${DIFF} -lt 300 ]]; then
		rm -f "${QUESTION_FILE}"
		exit 0  # Allow stop — question pending
	fi
	rm -f "${QUESTION_FILE}"
fi

# Stagnation detection — only runs against ralph-state.json (has tasks array)
if [[ "${RALPH_ACTIVE}" == "true" ]]; then
	TASK_COUNT=$(jq '[.tasks[]?] | length' "${RALPH_STATE}" 2>/dev/null || echo "0")
	if [[ "${TASK_COUNT}" -eq 0 ]]; then
		MAX_STAGNATION=5
	else
		MAX_STAGNATION=3
	fi

	# Portable hash — md5sum (GNU/Linux) vs md5 (macOS BSD)
	if command -v md5sum &>/dev/null; then
		TASK_HASH=$(jq -r '[.tasks[]? | "\(.id):\(.status)"] | sort | join(",")' "${RALPH_STATE}" 2>/dev/null | md5sum | cut -d' ' -f1)
	else
		TASK_HASH=$(jq -r '[.tasks[]? | "\(.id):\(.status)"] | sort | join(",")' "${RALPH_STATE}" 2>/dev/null | md5 | cut -d' ' -f4)
	fi

	LAST_HASH=$(jq -r '.last_task_hash // ""' "${RALPH_STATE}" 2>/dev/null)
	STAGNATION=$(jq -r '.stagnation_count // 0' "${RALPH_STATE}" 2>/dev/null)

	if [[ "${TASK_HASH}" == "${LAST_HASH}" ]]; then
		STAGNATION=$((STAGNATION + 1))
	else
		STAGNATION=0
	fi

	# Update state atomically
	jq --arg hash "${TASK_HASH}" --argjson count "${STAGNATION}" \
		'.last_task_hash = $hash | .stagnation_count = $count' \
		"${RALPH_STATE}" > "${RALPH_STATE}.tmp" && \
		mv "${RALPH_STATE}.tmp" "${RALPH_STATE}"

	if [[ ${STAGNATION} -ge ${MAX_STAGNATION} ]]; then
		_log_hook_error "ralph stagnated (${STAGNATION}/${MAX_STAGNATION}) — allowing stop" "ralph-persistence.sh"
		# No progress — try boulder fallback before allowing stop
		check_boulder_fallback
		# Allow stop — no progress after threshold attempts and no fresh boulder plan
		exit 0
	fi

	# Plan-file-aware stagnation: supplement task-hash signal with plan checkbox state
	check_plan_file_progress
fi

# Count incomplete tasks in ralph-state.json
INCOMPLETE=0
if [[ "${RALPH_ACTIVE}" == "true" ]]; then
	INCOMPLETE=$(jq '[.tasks[]? | select(.status != "completed" and .status != "verified")] | length' "${RALPH_STATE}" 2>/dev/null || echo "0")
fi

if [[ "${INCOMPLETE}" -gt 0 ]]; then
	echo '{"decision":"block","reason":"[RALPH PERSISTENCE] Ralph mode is active with incomplete tasks. Continue working until oracle verification passes."}'
	exit 0
fi

# Stagnation detection for ultrawork (no tasks array — use subagent activity as signal)
if [[ "${ULTRAWORK_ACTIVE}" == "true" ]]; then
	SUBAGENTS_FILE="${STATE_DIR}/subagents.json"
	UW_STAGNATION=$(jq -r '.stagnation_count // 0' "${ULTRAWORK_STATE}" 2>/dev/null || echo "0")

	# Check if any agents are currently running
	UW_NOW=$(date +%s)
	UW_ACTIVE_AGENTS=0
	if [[ -f "${SUBAGENTS_FILE}" ]]; then
		UW_ACTIVE_AGENTS=$(jq --argjson now "${UW_NOW}" \
			'[.active[]? | select(.status == "running") | select(
				(.started_epoch // 0) > ($now - 900)
			)] | length' \
			"${SUBAGENTS_FILE}" 2>/dev/null || echo "0")
	fi

	# Increment stagnation when no agents running; reset when agents are active
	if [[ "${UW_ACTIVE_AGENTS}" -eq 0 ]]; then
		UW_STAGNATION=$((UW_STAGNATION + 1))
	else
		UW_STAGNATION=0
	fi

	# Update ultrawork-state.json atomically
	jq --argjson count "${UW_STAGNATION}" '.stagnation_count = $count' \
		"${ULTRAWORK_STATE}" > "${ULTRAWORK_STATE}.tmp" && \
		mv "${ULTRAWORK_STATE}.tmp" "${ULTRAWORK_STATE}"

	if [[ ${UW_STAGNATION} -ge 5 ]]; then
		# No agent activity — try boulder fallback before allowing stop
		check_boulder_fallback
		# No progress after threshold attempts and no fresh boulder plan — allow stop
		exit 0
	fi

	# Agent-aware check: if agents are running, allow stop (Claude should wait for them)
	if [[ "${UW_ACTIVE_AGENTS}" -gt 0 ]]; then
		exit 0  # Allow stop — waiting for background agents to complete
	fi

	echo '{"decision":"block","reason":"[ULTRAWORK PERSISTENCE] Ultrawork mode is active. Continue parallel execution of remaining tasks."}'
	exit 0
fi

# No incomplete tasks and ultrawork not active — try boulder fallback
check_boulder_fallback

exit 0
