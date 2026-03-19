#!/bin/bash

INPUT=$(cat)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"

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
		# No progress — try boulder fallback before allowing stop
		BOULDER_FILE="${STATE_DIR}/boulder.json"
		if [[ -f "${BOULDER_FILE}" ]]; then
			ACTIVE_PLAN=$(jq -r '.active_plan // ""' "${BOULDER_FILE}" 2>/dev/null)
			if [[ -n "${ACTIVE_PLAN}" && "${ACTIVE_PLAN}" != "null" ]]; then
				if command -v stat &>/dev/null; then
					BOULDER_MTIME=$(stat -c %Y "${BOULDER_FILE}" 2>/dev/null || stat -f %m "${BOULDER_FILE}" 2>/dev/null || echo 0)
					BOULDER_AGE=$(( $(date +%s) - BOULDER_MTIME ))
					if [[ ${BOULDER_AGE} -lt 900 ]]; then
						echo '{"decision":"block","reason":"[PERSISTENCE] Active work plan detected via boulder. Continue working on tasks."}'
						exit 0
					fi
				fi
			fi
		fi
		# Allow stop — no progress after threshold attempts and no fresh boulder plan
		exit 0
	fi
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

if [[ "${ULTRAWORK_ACTIVE}" == "true" ]]; then
	echo '{"decision":"block","reason":"[ULTRAWORK PERSISTENCE] Ultrawork mode is active. Continue parallel execution of remaining tasks."}'
	exit 0
fi

# No incomplete tasks and ultrawork not active — try boulder fallback
BOULDER_FILE="${STATE_DIR}/boulder.json"
if [[ -f "${BOULDER_FILE}" ]]; then
	ACTIVE_PLAN=$(jq -r '.active_plan // ""' "${BOULDER_FILE}" 2>/dev/null)
	if [[ -n "${ACTIVE_PLAN}" && "${ACTIVE_PLAN}" != "null" ]]; then
		if command -v stat &>/dev/null; then
			BOULDER_MTIME=$(stat -c %Y "${BOULDER_FILE}" 2>/dev/null || stat -f %m "${BOULDER_FILE}" 2>/dev/null || echo 0)
			BOULDER_AGE=$(( $(date +%s) - BOULDER_MTIME ))
			if [[ ${BOULDER_AGE} -lt 900 ]]; then
				echo '{"decision":"block","reason":"[PERSISTENCE] Active work plan detected via boulder. Continue working on tasks."}'
				exit 0
			fi
		fi
	fi
fi

exit 0
