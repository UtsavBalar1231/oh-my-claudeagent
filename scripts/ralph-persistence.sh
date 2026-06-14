#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

# Platform cap on consecutive Stop-hook blocks.
# At cap-1 consecutive blocks, yield gracefully with a resume instruction.
STOP_BLOCK_CAP="${CLAUDE_CODE_STOP_HOOK_BLOCK_CAP:-8}"

# Cap state file for counter-less block paths (boulder fallback + INCOMPLETE path).
RALPH_CAP_STATE="${STATE_DIR}/ralph-cap-state.json"

# Read or initialise cap state. Prints JSON object.
_cap_state_read() {
	if [[ -f "${RALPH_CAP_STATE}" ]]; then
		jq -r '.' "${RALPH_CAP_STATE}" 2>/dev/null || echo '{}'
	else
		echo '{}'
	fi
}

# Atomically write cap state JSON.
_cap_state_write() {
	local json="$1"
	local tmp
	tmp=$(mktemp) && printf '%s\n' "${json}" > "${tmp}" && mv "${tmp}" "${RALPH_CAP_STATE}"
}

# Set a mode's status to inactive so a stagnated or finished persistence mode disarms
# itself instead of lingering active across sessions. A mode that never auto-deactivates
# re-arms this Stop gate every turn — the root cause of month-old stuck ralph state.
deactivate_mode() {
	local state_file="$1"
	[[ -f "${state_file}" ]] || return 0
	local tmp
	tmp=$(mktemp) && jq '.status = "inactive"' "${state_file}" > "${tmp}" && mv "${tmp}" "${state_file}"
}

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
				boulder_mtime=$(stat -c %Y "${boulder_file}" 2>/dev/null || stat -f %m "${boulder_file}" 2>/dev/null || echo "")
				# Fail-closed: if stat returns empty, boulder mtime is unavailable — block stop conservatively.
				if [[ -z "${boulder_mtime}" ]]; then
					# Stop-block cap guard (stat-unavailable path).
					# Reset on progress (hash/complete change), yield at cap-1.
					local cap_json boulder_cnt
					cap_json=$(_cap_state_read)
					boulder_cnt=$(printf '%s\n' "${cap_json}" | jq -r '.boulder_block_count // 0')
					boulder_cnt=$((boulder_cnt + 1))
					local cur_hash cur_complete last_hash last_complete
					cur_complete=$(grep -c '^- \[x\] ' "${active_plan}" 2>/dev/null; true)
					cur_complete="${cur_complete:-0}"
					if command -v md5sum &>/dev/null; then
						cur_hash=$(grep '^- \[.\] ' "${active_plan}" 2>/dev/null | md5sum | cut -d' ' -f1)
					else
						cur_hash=$(grep '^- \[.\] ' "${active_plan}" 2>/dev/null | md5 | cut -d' ' -f4)
					fi
					cur_hash="${cur_hash:-}"
					last_hash=$(printf '%s\n' "${cap_json}" | jq -r '.boulder_last_plan_hash // ""')
					last_complete=$(printf '%s\n' "${cap_json}" | jq -r '.boulder_last_complete // 0')
					if [[ "${cur_hash}" != "${last_hash}" || "${cur_complete}" -gt "${last_complete}" ]]; then
						boulder_cnt=1
					fi
					_cap_state_write "$(printf '%s\n' "${cap_json}" | jq \
						--argjson cnt "${boulder_cnt}" \
						--arg hash "${cur_hash}" \
						--argjson com "${cur_complete}" \
						'.boulder_block_count = $cnt | .boulder_last_plan_hash = $hash | .boulder_last_complete = $com')"
					local cap_minus_one=$(( STOP_BLOCK_CAP - 1 ))
					if [[ ${boulder_cnt} -ge ${cap_minus_one} ]]; then
						log_hook_error "ralph cap guard yielding at boulder_block_count=${boulder_cnt} (cap=${STOP_BLOCK_CAP}, stat-unavailable path)" "ralph-persistence.sh"
						echo '{"reason":"[RALPH PERSISTENCE] Stop-block cap limit approached (stat-unavailable path). Yielding to platform. To resume: restart your task or invoke /oh-my-claudeagent:ralph again."}'
						exit 0
					fi
					echo '{"decision":"block","reason":"[PERSISTENCE] Active work plan detected via boulder (stat unavailable — fail-closed). Continue working on tasks."}'
					exit 0
				fi
				boulder_age=$(( $(date +%s) - boulder_mtime ))
				if [[ ${boulder_age} -lt 900 ]]; then
					# Stop-block cap guard (fresh boulder path).
					# Reset on progress (hash/complete change), yield at cap-1.
					local cap_json boulder_cnt
					cap_json=$(_cap_state_read)
					boulder_cnt=$(printf '%s\n' "${cap_json}" | jq -r '.boulder_block_count // 0')
					boulder_cnt=$((boulder_cnt + 1))
					local cur_hash cur_complete last_hash last_complete
					cur_complete=$(grep -c '^- \[x\] ' "${active_plan}" 2>/dev/null; true)
					cur_complete="${cur_complete:-0}"
					if command -v md5sum &>/dev/null; then
						cur_hash=$(grep '^- \[.\] ' "${active_plan}" 2>/dev/null | md5sum | cut -d' ' -f1)
					else
						cur_hash=$(grep '^- \[.\] ' "${active_plan}" 2>/dev/null | md5 | cut -d' ' -f4)
					fi
					cur_hash="${cur_hash:-}"
					last_hash=$(printf '%s\n' "${cap_json}" | jq -r '.boulder_last_plan_hash // ""')
					last_complete=$(printf '%s\n' "${cap_json}" | jq -r '.boulder_last_complete // 0')
					if [[ "${cur_hash}" != "${last_hash}" || "${cur_complete}" -gt "${last_complete}" ]]; then
						boulder_cnt=1
					fi
					_cap_state_write "$(printf '%s\n' "${cap_json}" | jq \
						--argjson cnt "${boulder_cnt}" \
						--arg hash "${cur_hash}" \
						--argjson com "${cur_complete}" \
						'.boulder_block_count = $cnt | .boulder_last_plan_hash = $hash | .boulder_last_complete = $com')"
					local cap_minus_one=$(( STOP_BLOCK_CAP - 1 ))
					if [[ ${boulder_cnt} -ge ${cap_minus_one} ]]; then
						log_hook_error "ralph cap guard yielding at boulder_block_count=${boulder_cnt} (cap=${STOP_BLOCK_CAP}, fresh boulder path)" "ralph-persistence.sh"
						echo '{"reason":"[RALPH PERSISTENCE] Stop-block cap limit approached. Yielding to platform. To resume: restart your task or invoke /oh-my-claudeagent:ralph again."}'
						exit 0
					fi
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
		log_hook_error "ralph stagnated (${STAGNATION}/${MAX_STAGNATION}) — allowing stop and deactivating ralph" "ralph-persistence.sh"
		deactivate_mode "${RALPH_STATE}"
		allow_stop_via_boulder_fallback
		exit 0
	fi

	# Plan-file-aware stagnation: supplement task-hash signal with plan checkbox state.
	# REQUIRES RALPH_STATE to be set — see line 41 above.
	# REQUIRES STAGNATION to be set — see line 92 above.
	boulder_file_pfp="${STATE_DIR}/boulder.json"
	if [[ -f "${boulder_file_pfp}" ]]; then
		active_plan_pfp=$(jq_read "${boulder_file_pfp}" '.active_plan // ""')
		if [[ -n "${active_plan_pfp}" && "${active_plan_pfp}" != "null" ]]; then
			# Resolve plan path: support both absolute and relative (relative to project root)
			plan_file_pfp="${active_plan_pfp}"
			if [[ ! -f "${plan_file_pfp}" ]]; then
				# Try relative to CLAUDE_PROJECT_ROOT if set
				project_root_pfp="${CLAUDE_PROJECT_ROOT:-}"
				if [[ -n "${project_root_pfp}" && -f "${project_root_pfp}/${active_plan_pfp}" ]]; then
					plan_file_pfp="${project_root_pfp}/${active_plan_pfp}"
				else
					log_hook_error "boulder active_plan references missing file: ${active_plan_pfp} — allowing stop" "ralph-persistence.sh"
					exit 0
				fi
			fi

			# Read current plan file mtime (portable: GNU stat then BSD stat)
			plan_mtime_pfp=$(stat -c %Y "${plan_file_pfp}" 2>/dev/null || stat -f %m "${plan_file_pfp}" 2>/dev/null || echo "")
			if [[ -n "${plan_mtime_pfp}" ]]; then
				# Count incomplete and complete checkboxes
				incomplete_pfp=$(grep -c '^- \[ \] ' "${plan_file_pfp}" 2>/dev/null || true)
				complete_pfp=$(grep -c '^- \[x\] ' "${plan_file_pfp}" 2>/dev/null || true)
				incomplete_pfp="${incomplete_pfp:-0}"
				complete_pfp="${complete_pfp:-0}"

				# Read previous values from ralph-state.json
				last_mtime_pfp=$(jq_read "${RALPH_STATE}" '.last_plan_mtime // ""')
				plan_stagnation_pfp=$(jq_read "${RALPH_STATE}" '.plan_stagnation_count // 0')
				last_mtime_pfp="${last_mtime_pfp:-}"
				plan_stagnation_pfp="${plan_stagnation_pfp:-0}"

				# Detect plan-level stagnation: mtime unchanged AND incomplete count > 0 AND
				# task-hash also unchanged (STAGNATION > 0 means hash matched at least once)
				if [[ "${incomplete_pfp}" -gt 0 && "${plan_mtime_pfp}" == "${last_mtime_pfp}" && "${STAGNATION}" -gt 0 ]]; then
					plan_stagnation_pfp=$((plan_stagnation_pfp + 1))
				else
					plan_stagnation_pfp=0
				fi

				jq --arg mtime "${plan_mtime_pfp}" \
					--argjson inc "${incomplete_pfp}" \
					--argjson com "${complete_pfp}" \
					--argjson psc "${plan_stagnation_pfp}" \
					'.last_plan_mtime = $mtime | .last_plan_incomplete = $inc | .last_plan_complete = $com | .plan_stagnation_count = $psc' \
					"${RALPH_STATE}" > "${RALPH_STATE}.tmp" && \
					mv "${RALPH_STATE}.tmp" "${RALPH_STATE}"

				if [[ ${plan_stagnation_pfp} -ge 3 ]]; then
					log_hook_error "ralph plan stagnated (plan_stagnation_count=${plan_stagnation_pfp}, incomplete=${incomplete_pfp}) — allowing stop and deactivating ralph" "ralph-persistence.sh"
					deactivate_mode "${RALPH_STATE}"
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
	# Stop-block cap guard (INCOMPLETE path).
	# Stagnation machinery won't fire when progress occurs but tasks remain; this counter
	# prevents a platform hard-cut on long-running healthy plans.
	CAP_JSON_INC=$(_cap_state_read)
	INCOMPLETE_CNT=$(printf '%s\n' "${CAP_JSON_INC}" | jq -r '.incomplete_block_count // 0')
	INCOMPLETE_CNT=$((INCOMPLETE_CNT + 1))
	# Reset on genuine progress: mirror task-hash change signal (STAGNATION==0 means hash changed)
	if [[ "${STAGNATION:-1}" -eq 0 ]]; then
		INCOMPLETE_CNT=1
	fi
	_cap_state_write "$(printf '%s\n' "${CAP_JSON_INC}" | jq \
		--argjson cnt "${INCOMPLETE_CNT}" \
		'.incomplete_block_count = $cnt')"
	CAP_MINUS_ONE_INC=$(( STOP_BLOCK_CAP - 1 ))
	if [[ ${INCOMPLETE_CNT} -ge ${CAP_MINUS_ONE_INC} ]]; then
		log_hook_error "ralph cap guard yielding at incomplete_block_count=${INCOMPLETE_CNT} (cap=${STOP_BLOCK_CAP}, INCOMPLETE path)" "ralph-persistence.sh"
		echo '{"reason":"[RALPH PERSISTENCE] Stop-block cap limit approached with incomplete tasks. Yielding to platform. To resume: invoke /oh-my-claudeagent:ralph again."}'
		exit 0
	fi
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
		deactivate_mode "${ULTRAWORK_STATE}"
		allow_stop_via_boulder_fallback
		exit 0
	fi

	if [[ "${UW_ACTIVE_AGENTS}" -gt 0 ]]; then
		exit 0
	fi

	# No live agents and ultrawork still active: bound this block with a MONOTONIC
	# consecutive-block counter that resets ONLY when ultrawork yields — never on sibling
	# presence — so an oscillating or stale agent count cannot loop it unboundedly. This
	# is the one block path that previously had no STOP_BLOCK_CAP backstop at all.
	UW_CAP_JSON=$(_cap_state_read)
	UW_BLOCK_CNT=$(printf '%s\n' "${UW_CAP_JSON}" | jq -r '.ultrawork_block_count // 0')
	UW_BLOCK_CNT=$((UW_BLOCK_CNT + 1))
	if [[ ${UW_BLOCK_CNT} -ge $(( STOP_BLOCK_CAP - 1 )) ]]; then
		log_hook_error "ultrawork cap yielding at ultrawork_block_count=${UW_BLOCK_CNT} (cap=${STOP_BLOCK_CAP}) — deactivating ultrawork" "ralph-persistence.sh"
		_cap_state_write "$(printf '%s\n' "${UW_CAP_JSON}" | jq '.ultrawork_block_count = 0')"
		deactivate_mode "${ULTRAWORK_STATE}"
		echo '{"reason":"[ULTRAWORK PERSISTENCE] Consecutive Stop-block cap reached — yielding and deactivating ultrawork. To resume: invoke /oh-my-claudeagent:ultrawork again, or /oh-my-claudeagent:stop-continuation to clear persistence."}'
		exit 0
	fi
	_cap_state_write "$(printf '%s\n' "${UW_CAP_JSON}" | jq --argjson c "${UW_BLOCK_CNT}" '.ultrawork_block_count = $c')"
	echo '{"decision":"block","reason":"[ULTRAWORK PERSISTENCE] Ultrawork mode is active. Continue parallel execution of remaining tasks."}'
	exit 0
fi

allow_stop_via_boulder_fallback

exit 0
