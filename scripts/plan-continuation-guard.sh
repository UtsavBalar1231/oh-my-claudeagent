#!/bin/bash
# plan-continuation-guard.sh: blocks Stop when THIS SESSION's bound plan
# (resolved strictly: an explicit boulder.json binding only, never a
# sole-plan or most-recent fallback) still has unchecked numbered tasks,
# nudging the agent to keep working instead of stopping mid-plan. An unbound
# session is never blocked on a plan it has no relationship to. Disjoint by
# construction with final-verification-evidence.sh:
# that gate fires only when the plan is fully checked, this one only when it
# has unchecked boxes remaining, both read counts from the same
# count_plan_checkboxes helper, so they can never both fire for the same state.
# Rails, in order (each exits 0 before any counter mutation): (1) recursion
# guard, (2) kill switch, (3) no bound/missing plan, (4) no unchecked boxes,
# (5) user-pause intent, (6) recent compaction stamp, (7) stale binding with no
# fresh evidence, (8) assistant's last message is a question, (9) counters:
# exponential cooldown, hard cap, stagnation escape.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"
STATE_FILE="${STATE_DIR}/plan-continuation.json"

# 60s: rail 6 compaction-recency window: a compaction just happened, give the
# session a moment to resettle before nudging it to keep going.
COMPACTION_FRESH_SECONDS=60
# 86400s (24h): rail 7 binding staleness threshold: a binding this old with no
# fresh evidence looks abandoned rather than actively worked.
STALE_BINDING_SECONDS=86400
# 300s (5m): rail 9 clean window: this long since the last block resets the
# hard-cap counter, so a session that resumes cleanly isn't punished forever.
CLEAN_WINDOW_SECONDS=300
# 5: rail 9 hard cap: this many consecutive blocks without a clean window and
# the guard backs off for good (until the clean window resets it).
HARD_CAP_BLOCKS=5
# 3: rail 9 stagnation streak: this many consecutive blocks with an unchanged
# unchecked-count means the agent isn't making progress; stop nagging.
STAGNATION_STREAK=3
# 5s: rail 9 cooldown base: doubled per consecutive block (5, 10, 20, 40, 80s).
BASE_COOLDOWN_SECONDS=5

noop_exit() {
	printf '{}\n'
	exit 0
}

# stdin read timed out: HOOK_INPUT is empty/unreliable, so stop_hook_active and
# the plan/user-message signals below cannot be trusted. Mirrors the fail-open
# convention in final-verification-evidence.sh and drift-guard.sh.
if [[ "${HOOK_INPUT_TIMED_OUT:-0}" -eq 1 ]]; then
	echo "[PLAN CONTINUATION] stdin read timed out, cannot evaluate plan state this Stop. Allowing." >&2
	noop_exit
fi

# Rail 1: recursion guard
STOP_HOOK_ACTIVE=$(jq -r '.stop_hook_active // false' <<< "${HOOK_INPUT}")
if [[ "${STOP_HOOK_ACTIVE}" == "true" ]]; then
	noop_exit
fi

# Rail 2: kill switch
if hook_is_disabled "plan-continuation-guard"; then
	echo "[PLAN CONTINUATION] Disabled via OMCA_DISABLED_HOOKS, skipping check." >&2
	noop_exit
fi

# Rail 3: resolve the session's bound plan via the shared shim (never
# hand-parse boulder.json), mirrors final-verification-evidence.sh exactly so
# both hooks agree on which plan, if any, this session is bound to. --strict:
# an explicit binding only, never the sole-plan/most-recent fallback. An
# unbound session must never be blocked on a plan it has no relationship to.
BOULDER_RESOLVED=$(python3 "${PLUGIN_ROOT}/servers/tools/boulder_resolve.py" "$(resolve_session_id)" "${HOOK_PROJECT_ROOT}" --strict 2>/dev/null)
ACTIVE_PLAN=$(jq -r '.active_plan // ""' <<< "${BOULDER_RESOLVED:-{\}}" 2>/dev/null)
PLAN_NAME=$(jq -r '.plan_name // ""' <<< "${BOULDER_RESOLVED:-{\}}" 2>/dev/null)

if [[ -z "${ACTIVE_PLAN}" || ! -f "${ACTIVE_PLAN}" ]]; then
	noop_exit
fi

# Rail 4: no unchecked boxes, nothing to nudge. Disjoint with
# final-verification-evidence.sh by construction: that gate only fires when
# INCOMPLETE == 0.
read -r INCOMPLETE _COMPLETE _TOTAL _RAW_UNCHECKED < <(count_plan_checkboxes "${ACTIVE_PLAN}")
if [[ "${INCOMPLETE}" -eq 0 ]]; then
	noop_exit
fi

# --- Shared transcript/message text extraction -----------------------------
# The Stop payload is confirmed (via final-verification-evidence.sh and
# drift-guard.sh) to carry `.stop_hook_active` and `.transcript_path`. An
# inline `.messages` array is read defensively first (unconfirmed but cheap to
# probe) before falling back to tailing the transcript file, matching the
# pattern drift-guard.sh already uses for assistant text. Transcript lines are
# JSONL with `.type` and `.message.role` both set to the speaker's role; this
# mirrors drift-guard.sh's assistant extraction, generalized to a $role param;
# unconfirmed for the "user" role specifically since no prior hook reads it,
# so this rail is best-effort and fails toward skipping (exit 0) on any
# extraction failure, per the pause rail's own uncertainty-favors-pause intent.
extract_from_messages() {
	local role="$1"
	jq -r --arg role "${role}" '
		(.messages // empty) as $msgs
		| ($msgs | map(select(.role == $role)) | last) as $last
		| if $last == null then empty
		  else
		    ($last.content) as $c
		    | if ($c | type) == "string" then $c
		      else ($c // [] | map(select(.type == "text") | .text) | join("\n"))
		      end
		  end
	' <<< "${HOOK_INPUT}" 2>/dev/null
}

extract_from_transcript() {
	local transcript="$1"
	local role="$2"
	local line text
	while IFS= read -r line; do
		text=$(jq -r --arg role "${role}" '
			select(.type == $role and (.message.role == $role))
			| .message.content as $c
			| if ($c | type) == "string" then $c
			  else ($c // [] | map(select(.type == "text") | .text) | join("\n"))
			  end
		' <<< "${line}" 2>/dev/null)
		if [[ -n "${text}" && "${text}" != "null" ]]; then
			printf '%s' "${text}"
			return 0
		fi
	done < <(tac "${transcript}" 2>/dev/null)
	return 1
}

extract_last_text() {
	local role="$1"
	local text
	text=$(extract_from_messages "${role}")
	if [[ -z "${text}" || "${text}" == "null" ]]; then
		local transcript_path
		transcript_path=$(jq -r '.transcript_path // ""' <<< "${HOOK_INPUT}" 2>/dev/null)
		if [[ -n "${transcript_path}" && -f "${transcript_path}" ]]; then
			text=$(extract_from_transcript "${transcript_path}" "${role}")
		fi
	fi
	printf '%s' "${text}"
}

# Rail 5: user-pause intent. Conservative, word-boundary, case-insensitive
# phrase list. Apostrophes are stripped from both text and pattern so
# "that's enough" matches without fighting bash quoting.
USER_TEXT=$(extract_last_text "user")
if [[ -n "${USER_TEXT}" && "${USER_TEXT}" != "null" ]]; then
	LOWER_USER_TEXT=$(tr '[:upper:]' '[:lower:]' <<< "${USER_TEXT}" | tr -d "'")
	PAUSE_RE='\b(pause|stop here|thats enough|later|hold off|take a break)\b'
	if grep -qiE "${PAUSE_RE}" <<< "${LOWER_USER_TEXT}"; then
		noop_exit
	fi
fi

# Rail 6: compaction rail. A later task wires the stamping; absent file simply
# means this rail never fires.
COMPACTION_STAMP="${STATE_DIR}/last-compaction-at"
if [[ -f "${COMPACTION_STAMP}" ]]; then
	COMPACTION_AT=$(cat "${COMPACTION_STAMP}" 2>/dev/null)
	NOW_FOR_COMPACTION=$(date +%s)
	if [[ "${COMPACTION_AT}" =~ ^[0-9]+$ ]] && (( NOW_FOR_COMPACTION - COMPACTION_AT < COMPACTION_FRESH_SECONDS )); then
		noop_exit
	fi
fi

# Rail 7: stale-binding escape. `boulder_resolve.py` doesn't expose `bound_at`
# (it only returns the plan_name/active_plan/worktree_path triple), so this
# reads bindings[session_id].bound_at directly from boulder.json, a single
# extra field read, not a re-implementation of the resolution ladder itself.
# Best-effort proxy for "evidence logged this session": the evidence file's
# mtime relative to bound_at (per-session evidence timestamps aren't cheaply
# separable from other sessions' entries in this file).
BOULDER_FILE="${STATE_DIR}/boulder.json"
if [[ -f "${BOULDER_FILE}" ]]; then
	SESSION_ID_FOR_BINDING=$(resolve_session_id)
	BOUND_AT=$(jq -r --arg sid "${SESSION_ID_FOR_BINDING}" '.bindings[$sid].bound_at // empty' "${BOULDER_FILE}" 2>/dev/null)
	if [[ "${BOUND_AT}" =~ ^[0-9]+$ ]]; then
		NOW_FOR_BINDING=$(date +%s)
		if (( NOW_FOR_BINDING - BOUND_AT > STALE_BINDING_SECONDS )); then
			EVIDENCE_FILE=$(resolve_evidence_file "${STATE_DIR}")
			EVIDENCE_MTIME=""
			if [[ -f "${EVIDENCE_FILE}" ]]; then
				EVIDENCE_MTIME=$(stat -c %Y "${EVIDENCE_FILE}" 2>/dev/null)
			fi
			if [[ -z "${EVIDENCE_MTIME}" ]] || (( EVIDENCE_MTIME <= BOUND_AT )); then
				noop_exit
			fi
		fi
	fi
fi

# Rail 8: assistant's last message ends in a question. Heuristic: trailing
# whitespace trimmed, text ends in "?". "Directed at the user" isn't reliably
# separable from rhetorical/code-quoted question marks with the fields
# available, so this stays intentionally simple and conservative.
ASSISTANT_TEXT=$(extract_last_text "assistant")
if [[ -n "${ASSISTANT_TEXT}" && "${ASSISTANT_TEXT}" != "null" ]]; then
	TRIMMED_ASSISTANT_TEXT="${ASSISTANT_TEXT%"${ASSISTANT_TEXT##*[![:space:]]}"}"
	if [[ -n "${TRIMMED_ASSISTANT_TEXT}" && "${TRIMMED_ASSISTANT_TEXT}" == *\? ]]; then
		noop_exit
	fi
fi

# --- Rail 9: counters, cooldown, hard cap, stagnation -----------------------
write_continuation_state() {
	local consecutive="$1" last_block_at="$2" last_unchecked="$3" same_count_run="$4" stagnated="$5"
	local tmp
	tmp=$(mktemp -p "${STATE_DIR}" 2>/dev/null) || {
		log_hook_error "mktemp failed for plan-continuation.json" "$(basename "$0")"
		return 1
	}
	if jq -n \
		--argjson consecutive "${consecutive}" \
		--argjson last_block_at "${last_block_at}" \
		--argjson last_unchecked "${last_unchecked}" \
		--argjson same_count_run "${same_count_run}" \
		--argjson stagnated "${stagnated}" \
		'{"consecutive_blocks": $consecutive, "last_block_at": $last_block_at, "last_unchecked_count": $last_unchecked, "same_count_run": $same_count_run, "stagnated": $stagnated}' \
		> "${tmp}" 2>/dev/null
	then
		mv "${tmp}" "${STATE_FILE}" || {
			rm -f "${tmp}"
			log_hook_error "mv failed for plan-continuation.json" "$(basename "$0")"
			return 1
		}
	else
		rm -f "${tmp}"
		log_hook_error "jq build failed for plan-continuation.json" "$(basename "$0")"
		return 1
	fi
	return 0
}

CONSECUTIVE_BLOCKS=$(jq_read "${STATE_FILE}" '.consecutive_blocks // 0')
LAST_BLOCK_AT=$(jq_read "${STATE_FILE}" '.last_block_at // 0')
LAST_UNCHECKED_COUNT=$(jq_read "${STATE_FILE}" '.last_unchecked_count // -1')
SAME_COUNT_RUN=$(jq_read "${STATE_FILE}" '.same_count_run // 0')
STAGNATED=$(jq_read "${STATE_FILE}" '.stagnated // false')

# Any state field that failed to parse to the expected type is a corrupt/edge
# state file, fail open rather than risk arithmetic on garbage.
if ! [[ "${CONSECUTIVE_BLOCKS}" =~ ^[0-9]+$ && "${LAST_BLOCK_AT}" =~ ^[0-9]+$ && "${LAST_UNCHECKED_COUNT}" =~ ^-?[0-9]+$ && "${SAME_COUNT_RUN}" =~ ^[0-9]+$ ]]; then
	log_hook_error "plan-continuation.json has malformed counters, failing open" "$(basename "$0")"
	noop_exit
fi

if [[ "${STAGNATED}" == "true" ]]; then
	noop_exit
fi

NOW=$(date +%s)

# Hard cap + clean-window reset
if [[ "${CONSECUTIVE_BLOCKS}" -ge "${HARD_CAP_BLOCKS}" ]]; then
	if (( NOW - LAST_BLOCK_AT >= CLEAN_WINDOW_SECONDS )); then
		CONSECUTIVE_BLOCKS=0
	else
		noop_exit
	fi
fi

# Exponential cooldown
COOLDOWN_SECONDS=$(( BASE_COOLDOWN_SECONDS * (1 << CONSECUTIVE_BLOCKS) ))
if (( NOW - LAST_BLOCK_AT < COOLDOWN_SECONDS )); then
	noop_exit
fi

# Stagnation: if the last STAGNATION_STREAK consecutive blocks already shared
# this same unchecked count, this call would be the (STAGNATION_STREAK+1)th in
# a row with no progress: stop nagging and persist the escape for the rest of
# the session instead of blocking again.
if [[ "${INCOMPLETE}" -eq "${LAST_UNCHECKED_COUNT}" && "${SAME_COUNT_RUN}" -ge "${STAGNATION_STREAK}" ]]; then
	write_continuation_state "${CONSECUTIVE_BLOCKS}" "${LAST_BLOCK_AT}" "${INCOMPLETE}" "${SAME_COUNT_RUN}" "true" || true
	noop_exit
fi

if [[ "${INCOMPLETE}" -eq "${LAST_UNCHECKED_COUNT}" ]]; then
	NEW_SAME_COUNT_RUN=$(( SAME_COUNT_RUN + 1 ))
else
	NEW_SAME_COUNT_RUN=1
fi
NEW_CONSECUTIVE_BLOCKS=$(( CONSECUTIVE_BLOCKS + 1 ))

if ! write_continuation_state "${NEW_CONSECUTIVE_BLOCKS}" "${NOW}" "${INCOMPLETE}" "${NEW_SAME_COUNT_RUN}" "false"; then
	noop_exit
fi

NEXT_TASK=$(grep -m1 -E '^- \[ \] [0-9]+\.' "${ACTIVE_PLAN}" | sed -E 's/^- \[ \] [0-9]+\.[[:space:]]*//')
echo "[PLAN CONTINUATION] The bound plan '${PLAN_NAME}' still has ${INCOMPLETE} unchecked tasks (next: ${NEXT_TASK}). If you believe the work is complete, re-examine each unchecked item skeptically; finish it or record in the plan notepad why it cannot proceed." >&2
exit 2
