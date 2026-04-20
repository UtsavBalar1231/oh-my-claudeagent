#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

# Boulder fallback: block stop if a fresh work plan exists.
# NAMED WITH ACTION VERB: side-effect is intentional, see caller chains.
allow_stop_via_boulder_fallback() {
	local boulder_file="${STATE_DIR}/boulder.json"
	if [[ -f "${boulder_file}" ]]; then
		local active_plan
		active_plan=$(jq_read "${boulder_file}" '.active_plan // ""')
		if [[ -n "${active_plan}" && "${active_plan}" != "null" ]]; then
			# Plan file deleted by platform — allow stop immediately
			if [[ ! -f "${active_plan}" ]]; then
				log_hook_error "boulder active_plan references missing file: ${active_plan} — allowing stop" "ralph-persistence.sh"
				exit 0
			fi
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
STOP_HOOK_ACTIVE=$(jq -r '.stop_hook_active // false' <<< "${HOOK_INPUT}")
if [[ "${STOP_HOOK_ACTIVE}" == "true" ]]; then
	exit 0
fi

RALPH_STATE="${STATE_DIR}/ralph-state.json"
ULTRAWORK_STATE="${STATE_DIR}/ultrawork-state.json"

RALPH_ACTIVE=false
ULTRAWORK_ACTIVE=false

if [[ -f "${RALPH_STATE}" ]]; then
	STATUS=$(jq_read "${RALPH_STATE}" '.status // "inactive"')
	[[ "${STATUS}" == "active" ]] && RALPH_ACTIVE=true
fi

if [[ -f "${ULTRAWORK_STATE}" ]]; then
	STATUS=$(jq_read "${ULTRAWORK_STATE}" '.status // "inactive"')
	[[ "${STATUS}" == "active" ]] && ULTRAWORK_ACTIVE=true
fi

if [[ "${RALPH_ACTIVE}" != "true" && "${ULTRAWORK_ACTIVE}" != "true" ]]; then
	exit 0  # No persistence mode active
fi

# Allow stop if a question is pending — user needs to answer
QUESTION_FILE="${STATE_DIR}/pending-question.json"
if [[ -f "${QUESTION_FILE}" ]]; then
	Q_TS=$(jq_read "${QUESTION_FILE}" '.timestamp // 0')
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
	TASK_COUNT=$(jq '[.tasks[]?] | length' "${RALPH_STATE}")
	if [[ "${TASK_COUNT}" -eq 0 ]]; then
		# 5 attempts — free-form ralph (no tasks); harder to measure progress. UNDOCUMENTED.
		MAX_STAGNATION=5
	else
		# 3 attempts — task list present; task-hash changes are reliable progress signals.
		MAX_STAGNATION=3
	fi

	# Portable hash — md5sum (GNU/Linux) vs md5 (macOS BSD)
	if command -v md5sum &>/dev/null; then
		TASK_HASH=$(jq -r '[.tasks[]? | "\(.id):\(.status)"] | sort | join(",")' "${RALPH_STATE}" | md5sum | cut -d' ' -f1)
	else
		TASK_HASH=$(jq -r '[.tasks[]? | "\(.id):\(.status)"] | sort | join(",")' "${RALPH_STATE}" | md5 | cut -d' ' -f4)
	fi

	LAST_HASH=$(jq_read "${RALPH_STATE}" '.last_task_hash // ""')
	STAGNATION=$(jq_read "${RALPH_STATE}" '.stagnation_count // 0')

	if [[ "${TASK_HASH}" == "${LAST_HASH}" ]]; then
		STAGNATION=$((STAGNATION + 1))
	else
		STAGNATION=0
	fi

	jq --arg hash "${TASK_HASH}" --argjson count "${STAGNATION}" \
		'.last_task_hash = $hash | .stagnation_count = $count' \
		"${RALPH_STATE}" > "${RALPH_STATE}.tmp" && \
		mv "${RALPH_STATE}.tmp" "${RALPH_STATE}"

	if [[ ${STAGNATION} -ge ${MAX_STAGNATION} ]]; then
		log_hook_error "ralph stagnated (${STAGNATION}/${MAX_STAGNATION}) — allowing stop" "ralph-persistence.sh"
		allow_stop_via_boulder_fallback
		exit 0
	fi

	# Plan-file-aware stagnation: supplement task-hash signal with plan checkbox state.
	# REQUIRES RALPH_STATE to be set — see line 41 above.
	# REQUIRES STAGNATION to be set — see line 92 above.
	_boulder_file_pfp="${STATE_DIR}/boulder.json"
	if [[ -f "${_boulder_file_pfp}" ]]; then
		_active_plan_pfp=$(jq_read "${_boulder_file_pfp}" '.active_plan // ""')
		if [[ -n "${_active_plan_pfp}" && "${_active_plan_pfp}" != "null" ]]; then
			# Resolve plan path: support both absolute and relative (relative to project root)
			_plan_file_pfp="${_active_plan_pfp}"
			if [[ ! -f "${_plan_file_pfp}" ]]; then
				# Try relative to CLAUDE_PROJECT_ROOT if set
				_project_root_pfp="${CLAUDE_PROJECT_ROOT:-}"
				if [[ -n "${_project_root_pfp}" && -f "${_project_root_pfp}/${_active_plan_pfp}" ]]; then
					_plan_file_pfp="${_project_root_pfp}/${_active_plan_pfp}"
				else
					log_hook_error "boulder active_plan references missing file: ${_active_plan_pfp} — allowing stop" "ralph-persistence.sh"
					exit 0
				fi
			fi

			# Read current plan file mtime (portable: GNU stat then BSD stat)
			_plan_mtime_pfp=$(stat -c %Y "${_plan_file_pfp}" 2>/dev/null || stat -f %m "${_plan_file_pfp}" 2>/dev/null || echo "")
			if [[ -n "${_plan_mtime_pfp}" ]]; then
				# Count incomplete and complete checkboxes
				_incomplete_pfp=$(grep -c '^- \[ \] ' "${_plan_file_pfp}" 2>/dev/null || true)
				_complete_pfp=$(grep -c '^- \[x\] ' "${_plan_file_pfp}" 2>/dev/null || true)
				_incomplete_pfp="${_incomplete_pfp:-0}"
				_complete_pfp="${_complete_pfp:-0}"

				# Read previous values from ralph-state.json
				_last_mtime_pfp=$(jq_read "${RALPH_STATE}" '.last_plan_mtime // ""')
				_plan_stagnation_pfp=$(jq_read "${RALPH_STATE}" '.plan_stagnation_count // 0')
				_last_mtime_pfp="${_last_mtime_pfp:-}"
				_plan_stagnation_pfp="${_plan_stagnation_pfp:-0}"

				# Detect plan-level stagnation: mtime unchanged AND incomplete count > 0 AND
				# task-hash also unchanged (STAGNATION > 0 means hash matched at least once)
				if [[ "${_incomplete_pfp}" -gt 0 && "${_plan_mtime_pfp}" == "${_last_mtime_pfp}" && "${STAGNATION}" -gt 0 ]]; then
					_plan_stagnation_pfp=$((_plan_stagnation_pfp + 1))
				else
					_plan_stagnation_pfp=0
				fi

				jq --arg mtime "${_plan_mtime_pfp}" \
					--argjson inc "${_incomplete_pfp}" \
					--argjson com "${_complete_pfp}" \
					--argjson psc "${_plan_stagnation_pfp}" \
					'.last_plan_mtime = $mtime | .last_plan_incomplete = $inc | .last_plan_complete = $com | .plan_stagnation_count = $psc' \
					"${RALPH_STATE}" > "${RALPH_STATE}.tmp" && \
					mv "${RALPH_STATE}.tmp" "${RALPH_STATE}"

				if [[ ${_plan_stagnation_pfp} -ge 3 ]]; then
					log_hook_error "ralph plan stagnated (plan_stagnation_count=${_plan_stagnation_pfp}, incomplete=${_incomplete_pfp}) — allowing stop" "ralph-persistence.sh"
					allow_stop_via_boulder_fallback
					exit 0
				fi
			fi
		fi
	fi
fi

INCOMPLETE=0
if [[ "${RALPH_ACTIVE}" == "true" ]]; then
	INCOMPLETE=$(jq '[.tasks[]? | select(.status != "completed" and .status != "verified")] | length' "${RALPH_STATE}")
fi

if [[ "${INCOMPLETE}" -gt 0 ]]; then
	echo '{"decision":"block","reason":"[RALPH PERSISTENCE] Ralph mode is active with incomplete tasks. Continue working until oracle verification passes."}'
	exit 0
fi

# Stagnation detection for ultrawork (no tasks array — use subagent activity as signal)
if [[ "${ULTRAWORK_ACTIVE}" == "true" ]]; then
	SUBAGENTS_FILE="${STATE_DIR}/subagents.json"
	UW_STAGNATION=$(jq_read "${ULTRAWORK_STATE}" '.stagnation_count // 0')

	UW_NOW=$(date +%s)
	UW_ACTIVE_AGENTS=0
	if [[ -f "${SUBAGENTS_FILE}" ]]; then
		UW_ACTIVE_AGENTS=$(jq --argjson now "${UW_NOW}" \
			'[.active[]? | select(.status == "running") | select(
				(.started_epoch // 0) > ($now - 900)
			)] | length' \
			"${SUBAGENTS_FILE}")
	fi

	if [[ "${UW_ACTIVE_AGENTS}" -eq 0 ]]; then
		UW_STAGNATION=$((UW_STAGNATION + 1))
	else
		UW_STAGNATION=0
	fi

	jq --argjson count "${UW_STAGNATION}" '.stagnation_count = $count' \
		"${ULTRAWORK_STATE}" > "${ULTRAWORK_STATE}.tmp" && \
		mv "${ULTRAWORK_STATE}.tmp" "${ULTRAWORK_STATE}"

	if [[ ${UW_STAGNATION} -ge 5 ]]; then
		allow_stop_via_boulder_fallback
		exit 0
	fi

	if [[ "${UW_ACTIVE_AGENTS}" -gt 0 ]]; then
		exit 0
	fi

	echo '{"decision":"block","reason":"[ULTRAWORK PERSISTENCE] Ultrawork mode is active. Continue parallel execution of remaining tasks."}'
	exit 0
fi

allow_stop_via_boulder_fallback

exit 0
