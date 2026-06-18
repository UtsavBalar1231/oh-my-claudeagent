#!/bin/bash
# ralph-persistence.sh — Stop hook. Blocks Stop while a persistence mode (ralph/ultrawork)
# has incomplete work, bounded by one monotonic consecutive-block cap that yields fail-open;
# self-deactivates when done/idle. Truth = incomplete tasks + plan checkboxes + live agents.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
RALPH_STATE="${STATE_DIR}/ralph-state.json"
ULTRAWORK_STATE="${STATE_DIR}/ultrawork-state.json"
RALPH_CAP_STATE="${STATE_DIR}/ralph-cap-state.json"

# Platform cap on CONSECUTIVE Stop-hook blocks; yield (allow) at cap-1.
STOP_BLOCK_CAP="${CLAUDE_CODE_STOP_HOOK_BLOCK_CAP:-8}"
# 5 — consecutive no-work Stop attempts before a mode auto-deactivates. Gives the model a
# few turns to populate tasks after activation, then gives up rather than lingering active.
IDLE_MAX=5

_cap_read() {
	[[ -f "${RALPH_CAP_STATE}" ]] && jq -r '.global_block_count // 0' "${RALPH_CAP_STATE}" 2>/dev/null || echo 0
}
_cap_write() {
	local tmp
	tmp=$(mktemp) && printf '{"global_block_count":%d}\n' "$1" >"${tmp}" && mv "${tmp}" "${RALPH_CAP_STATE}"
}

# Set a mode's status to inactive (atomic) so a finished/idle mode disarms itself instead
# of re-arming this gate every turn.
deactivate_mode() {
	local f="$1" tmp
	[[ -f "${f}" ]] || return 0
	tmp=$(mktemp) && jq '.status = "inactive"' "${f}" >"${tmp}" 2>/dev/null && mv "${tmp}" "${f}"
}

# Reset the consecutive-block counter on any allow-stop exit. The cap counts only
# CONSECUTIVE blocks — a single allow clears it. The block path sets BLOCKED=1 to opt out.
BLOCKED=0
# SC2317 (older shellcheck flags trap-invoked function bodies as unreachable) + SC2329.
# shellcheck disable=SC2317,SC2329  # invoked indirectly via the EXIT trap below
reset_cap_on_allow() {
	[[ "${BLOCKED}" -eq 0 ]] || return 0
	[[ -f "${RALPH_CAP_STATE}" ]] || return 0
	local tmp
	tmp=$(mktemp) && jq '.global_block_count = 0' "${RALPH_CAP_STATE}" >"${tmp}" 2>/dev/null && mv "${tmp}" "${RALPH_CAP_STATE}"
}
trap reset_cap_on_allow EXIT

# Emit decision:block bounded by the monotonic global counter; at cap-1 yield (allow stop)
# with resume guidance. Optional $2 = a mode state file to deactivate when yielding.
block_or_yield() {
	local reason="$1" deactivate_on_yield="${2:-}" cnt
	cnt=$(_cap_read)
	cnt=$((cnt + 1))
	if [[ ${cnt} -ge $(( STOP_BLOCK_CAP - 1 )) ]]; then
		log_hook_error "ralph global cap yielding at global_block_count=${cnt} (cap=${STOP_BLOCK_CAP})" "ralph-persistence.sh"
		_cap_write 0
		[[ -n "${deactivate_on_yield}" ]] && deactivate_mode "${deactivate_on_yield}"
		printf '%s\n' '{"reason":"[RALPH PERSISTENCE] Consecutive Stop-block cap reached — yielding to platform. To resume: /oh-my-claudeagent:ralph; to clear persistence: /oh-my-claudeagent:stop-continuation."}'
		exit 0
	fi
	_cap_write "${cnt}"
	BLOCKED=1
	printf '%s\n' "{\"decision\":\"block\",\"reason\":\"${reason}\"}"
	exit 0
}

# Echo the count of incomplete `- [ ]` checkboxes in the active boulder plan; "0" when no
# boulder plan is configured; "allow" when boulder points at a deleted plan file (platform
# removed it → allow stop).
plan_incomplete_count() {
	local boulder_file="${STATE_DIR}/boulder.json" active_plan plan_file pr inc
	[[ -f "${boulder_file}" ]] || { echo 0; return; }
	active_plan=$(jq_read "${boulder_file}" '.active_plan // ""')
	[[ -n "${active_plan}" && "${active_plan}" != "null" ]] || { echo 0; return; }
	plan_file="${active_plan}"
	if [[ ! -f "${plan_file}" ]]; then
		pr="${CLAUDE_PROJECT_ROOT:-}"
		if [[ -n "${pr}" && -f "${pr}/${active_plan}" ]]; then
			plan_file="${pr}/${active_plan}"
		else
			echo allow
			return
		fi
	fi
	inc=$(grep -c '^- \[ \] ' "${plan_file}" 2>/dev/null || true)
	echo "${inc:-0}"
}

# Increment a mode's idle_count; deactivate at IDLE_MAX. Always allows stop.
note_idle_and_allow() {
	local f="$1" idle tmp
	idle=$(jq_read "${f}" '.idle_count // 0')
	idle=$(( ${idle:-0} + 1 ))
	if [[ ${idle} -ge ${IDLE_MAX} ]]; then
		log_hook_error "$(basename "${f}") idle ${idle}/${IDLE_MAX} — deactivating" "ralph-persistence.sh"
		deactivate_mode "${f}"
	elif [[ -f "${f}" ]]; then
		tmp=$(mktemp) && jq --argjson n "${idle}" '.idle_count = $n' "${f}" >"${tmp}" 2>/dev/null && mv "${tmp}" "${f}"
	fi
	exit 0
}

# Reset a mode's idle_count to 0 (the mode has active work this turn).
reset_idle() {
	local f="$1" tmp
	[[ -f "${f}" ]] || return 0
	tmp=$(mktemp) && jq '.idle_count = 0' "${f}" >"${tmp}" 2>/dev/null && mv "${tmp}" "${f}"
}

# --- main ------------------------------------------------------------------------
# Recursion guard — stop_hook_active prevents infinite Stop hook loops.
STOP_HOOK_ACTIVE=$(jq -r '.stop_hook_active // false' <<< "${HOOK_INPUT}")
[[ "${STOP_HOOK_ACTIVE}" == "true" ]] && exit 0

RALPH_ACTIVE=false
ULTRAWORK_ACTIVE=false
[[ -f "${RALPH_STATE}" ]] && [[ "$(jq_read "${RALPH_STATE}" '.status // "inactive"')" == "active" ]] && RALPH_ACTIVE=true
[[ -f "${ULTRAWORK_STATE}" ]] && [[ "$(jq_read "${ULTRAWORK_STATE}" '.status // "inactive"')" == "active" ]] && ULTRAWORK_ACTIVE=true

[[ "${RALPH_ACTIVE}" != "true" && "${ULTRAWORK_ACTIVE}" != "true" ]] && exit 0

# Pending question → allow stop (the user must answer).
QUESTION_FILE="${STATE_DIR}/pending-question.json"
if [[ -f "${QUESTION_FILE}" ]]; then
	Q_TS=$(jq_read "${QUESTION_FILE}" '.timestamp // 0')
	Q_TS=${Q_TS:-0}
	rm -f "${QUESTION_FILE}"
	[[ $(( $(date +%s) - Q_TS )) -lt 300 ]] && exit 0
fi

# RALPH: block while any task OR plan checkbox is incomplete; else idle toward deactivation.
if [[ "${RALPH_ACTIVE}" == "true" ]]; then
	INCOMPLETE_TASKS=$(jq '[.tasks[]? | select(.status != "completed" and .status != "verified")] | length' "${RALPH_STATE}")
	PLAN_INC=$(plan_incomplete_count)
	if [[ "${PLAN_INC}" == "allow" ]]; then
		log_hook_error "boulder active_plan references missing file — allowing stop and deactivating ralph" "ralph-persistence.sh"
		deactivate_mode "${RALPH_STATE}"
		exit 0
	fi
	if [[ "${INCOMPLETE_TASKS}" -gt 0 || "${PLAN_INC}" -gt 0 ]]; then
		reset_idle "${RALPH_STATE}"
		block_or_yield "[RALPH PERSISTENCE] Ralph mode is active with incomplete work (${INCOMPLETE_TASKS} task(s), ${PLAN_INC} plan item(s)). Continue until all are complete."
	fi
	# Ralph is active but has no work this turn — fall through to ultrawork (the two can
	# both be active); ralph's idle accounting happens at the end if nothing else blocks.
fi

# ULTRAWORK: allow while live agents run; else bounded block, deactivate on cap.
if [[ "${ULTRAWORK_ACTIVE}" == "true" ]]; then
	SUBAGENTS_FILE="${STATE_DIR}/subagents.json"
	NOW=$(date +%s)
	LIVE=0
	[[ -f "${SUBAGENTS_FILE}" ]] && LIVE=$(jq --argjson now "${NOW}" \
		'[.active[]? | select(.status == "running") | select((.started_epoch // 0) > ($now - 900))] | length' \
		"${SUBAGENTS_FILE}")
	if [[ "${LIVE}" -gt 0 ]]; then
		reset_idle "${ULTRAWORK_STATE}"
		exit 0
	fi
	block_or_yield "[ULTRAWORK PERSISTENCE] Ultrawork mode is active with no running agents. Continue parallel execution of remaining tasks." "${ULTRAWORK_STATE}"
fi

# Nothing blocked this turn. If ralph is the active-but-idle mode, advance its idle counter.
[[ "${RALPH_ACTIVE}" == "true" ]] && note_idle_and_allow "${RALPH_STATE}"
exit 0
