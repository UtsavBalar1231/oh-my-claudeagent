#!/bin/bash
# final-verification-evidence.sh — blocks Stop when a completed plan lacks F1-F4 evidence.
# F-types: final_verification_f1..f4 (plan compliance, code quality, manual QA, scope fidelity).
# Entries need plan_sha256:<hex> in output_snippet; all 4 must share the same SHA.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

# 604800s (7d) — absolute ceiling on marker-derived evidence age window.
AGE_WINDOW_CEILING_SECONDS=604800
# 3600s (1h) — fallback F1-F4 freshness when no marker is present; sibling task-completed-verify uses 300s. UNDOCUMENTED.
MAX_EVIDENCE_AGE_SECONDS=3600
# 86400s (24h) — orphan-marker TTL. Belt-and-suspenders behind session-ID mismatch guard.
MAX_MARKER_AGE_SECONDS=86400

noop_exit() {
	printf '{}\n'
	exit 0
}

# Kill switch for emergency rollback
if [[ "${OMCA_HOOK_DISABLE_FINAL_VERIFY:-}" == "1" ]]; then
	echo "[FINAL VERIFICATION] Kill switch active (OMCA_HOOK_DISABLE_FINAL_VERIFY=1) — skipping F1-F4 check." >&2
	noop_exit
fi

# Recursion guard
STOP_HOOK_ACTIVE=$(jq -r '.stop_hook_active // false' <<< "${HOOK_INPUT}")
if [[ "${STOP_HOOK_ACTIVE}" == "true" ]]; then
	noop_exit
fi

# Background-subagent guard: skip F1-F4 enforcement while agents are still running
SUBAGENTS_FILE="${STATE_DIR}/subagents.json"
FV_NOW=$(date +%s)
FV_ACTIVE_AGENTS=0
if [[ -f "${SUBAGENTS_FILE}" ]]; then
	FV_ACTIVE_AGENTS=$(jq --argjson now "${FV_NOW}" \
		'[.active[]? | select(.status == "running") | select(
			(.started_epoch // 0) > ($now - 900)
		)] | length' \
		"${SUBAGENTS_FILE}")
fi
if [[ "${FV_ACTIVE_AGENTS}" -gt 0 ]]; then
	log_hook_error "final-verification deferred: ${FV_ACTIVE_AGENTS} background subagent(s) still running" "final-verification-evidence.sh"
	noop_exit
fi

BOULDER_FILE="${STATE_DIR}/boulder.json"
MARKER_FILE="${STATE_DIR}/pending-final-verify.json"
EVIDENCE_FILE=$(resolve_evidence_file "${STATE_DIR}")

ACTIVE_PLAN=$(jq_read "${BOULDER_FILE}" '.active_plan // ""')

MARKER_PLAN=$(jq_read "${MARKER_FILE}" '.plan_path // ""')
MARKER_AT=$(jq_read "${MARKER_FILE}" '.marked_at // 0')
# Convert marker epoch to ISO for timestamp-scoped SHA-divergence check (empty string when marker absent).
MARKER_AT_ISO=""
if [[ -n "${MARKER_AT}" && "${MARKER_AT}" != "0" ]]; then
	MARKER_AT_ISO=$(date -u -d "@${MARKER_AT}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
fi

if [[ -z "${ACTIVE_PLAN}" && -z "${MARKER_PLAN}" ]]; then
	noop_exit
fi

# Orphan-marker TTL — a marker older than MAX_MARKER_AGE_SECONDS is stale REGARDLESS of
# whether boulder still references an active plan. Previously this only fired when
# ACTIVE_PLAN was empty, so a same-session orphan marker could block Stop forever. Clear
# it and allow stop (fail-open).
if [[ -n "${MARKER_PLAN}" && -n "${MARKER_AT}" && "${MARKER_AT}" != "0" ]]; then
	NOW_TTL=$(date +%s)
	if [[ $(( NOW_TTL - MARKER_AT )) -gt "${MAX_MARKER_AGE_SECONDS}" ]]; then
		log_hook_error "orphan final-verify marker older than ${MAX_MARKER_AGE_SECONDS}s — clearing and allowing stop" "final-verification-evidence.sh"
		rm -f "${MARKER_FILE}"
		noop_exit
	fi
fi

# Session-aware staleness short-circuits: runs before TTL/evidence check; each clears the
# marker and noop_exits when an independent signal proves it stale.
if [[ -n "${MARKER_PLAN}" ]]; then
	# Session-ID mismatch short-circuit.
	CURRENT_SID=$(resolve_session_id)
	MARKER_SID=$(jq_read "${MARKER_FILE}" '.session_id // ""')
	if [[ -z "${CURRENT_SID}" ]]; then
		log_hook_error "session-ID unresolvable; skipping mismatch short-circuit" "final-verification-evidence.sh"
	elif [[ -n "${MARKER_SID}" && "${MARKER_SID}" != "null" && "${MARKER_SID}" != "${CURRENT_SID}" ]]; then
		rm -f "${MARKER_FILE}"
		noop_exit
	fi

	# Completion sidecar with matching SHA short-circuit.
	MARKER_SHA=$(jq_read "${MARKER_FILE}" '.plan_sha256 // ""')
	if [[ -n "${MARKER_PLAN}" && -n "${MARKER_SHA}" ]]; then
		# Inline compute_sidecar_path: $CLAUDE_PROJECT_ROOT/.omca/notes/<plan-basename-.md>-completion.md
		SIDECAR_PATH="${CLAUDE_PROJECT_ROOT:-$(pwd)}/.omca/notes/$(basename "${MARKER_PLAN}" .md)-completion.md"
		# Inline sidecar_sha_matches: 0 when file exists and plan_sha256 line equals MARKER_SHA
		_SIDECAR_MATCHED=false
		if [[ -f "${SIDECAR_PATH}" ]]; then
			while IFS= read -r _sidecar_line; do
				case "${_sidecar_line}" in
					plan_sha256:*)
						_val="${_sidecar_line#plan_sha256:}"
						_val="${_val# }"
						_val="${_val#\"}"
						_val="${_val%\"}"
						[[ "${_val}" == "${MARKER_SHA}" ]] && _SIDECAR_MATCHED=true
						break
						;;
					*)
						;;
				esac
			done < "${SIDECAR_PATH}"
		fi
		if [[ "${_SIDECAR_MATCHED}" == true ]]; then
			rm -f "${MARKER_FILE}"
			noop_exit
		fi
	fi

	# Marker plan has zero [x] — never started, stale.
	if [[ -n "${MARKER_PLAN}" && -f "${MARKER_PLAN}" ]]; then
		if ! grep -qE '^- \[x\] ' "${MARKER_PLAN}" 2>/dev/null; then
			rm -f "${MARKER_FILE}"
			noop_exit
		fi
	fi
fi

# Cross-session ACTIVE_PLAN-without-MARKER short-circuit:
# active_plan from prior session is stale when no marker exists in this session.
# INVARIANT: must run BEFORE PLAN_PATH derivation — once PLAN_PATH falls back to
# MARKER_PLAN, the staleness signal is lost.
if [[ -n "${ACTIVE_PLAN}" && -z "${MARKER_PLAN}" ]]; then
	log_hook_info "cleared cross-session stale active_plan reference (no marker)" "final-verification-evidence.sh"
	noop_exit
fi

PLAN_PATH="${ACTIVE_PLAN}"
if [[ -z "${PLAN_PATH}" ]]; then
	PLAN_PATH="${MARKER_PLAN}"
fi

CURRENT_SHA=""
if [[ -n "${PLAN_PATH}" ]] && [[ -f "${PLAN_PATH}" ]]; then
	CURRENT_SHA=$(sha256sum "${PLAN_PATH}" 2>/dev/null | awk '{print $1}' || echo "")
fi

INCOMPLETE=0
COMPLETE=0
if [[ -n "${ACTIVE_PLAN}" && -f "${ACTIVE_PLAN}" ]]; then
	INCOMPLETE=$(grep -cE '^- \[ \] ' "${ACTIVE_PLAN}" 2>/dev/null || true)
	INCOMPLETE="${INCOMPLETE:-0}"
	COMPLETE=$(grep -cE '^- \[x\] ' "${ACTIVE_PLAN}" 2>/dev/null || true)
	COMPLETE="${COMPLETE:-0}"
fi

if [[ "${INCOMPLETE}" -gt 0 ]]; then
	noop_exit
fi

if [[ -z "${ACTIVE_PLAN}" && -n "${MARKER_PLAN}" ]]; then
	NOW=$(date +%s)
	MARKER_AGE=$(( NOW - ${MARKER_AT:-0} ))
	if [[ "${MARKER_AGE}" -gt "${MAX_MARKER_AGE_SECONDS}" ]]; then
		# Stale marker — do not block
		noop_exit
	fi
	# Fresh marker without active plan → /stop-continuation bypass attempt; fall through to evidence check
fi

if [[ "${INCOMPLETE}" -eq 0 && "${COMPLETE}" -eq 0 && -z "${MARKER_PLAN}" ]]; then
	noop_exit
fi

# Fail-closed on corrupt evidence file
if [[ -f "${EVIDENCE_FILE}" ]]; then
	if ! jq -e '.entries | arrays' "${EVIDENCE_FILE}" >/dev/null 2>&1; then
		echo "[FINAL VERIFICATION] Evidence file corrupt — refusing to allow Stop until manually repaired." >&2
		exit 2
	fi
fi

NOW=$(date +%s)

# Derive evidence age window from marker lifetime; floor at 3600s, ceiling at 7d.
if [[ "${MARKER_AT}" -gt 0 ]]; then
	AGE_WINDOW=$(( NOW - MARKER_AT ))
	if (( AGE_WINDOW < 3600 )); then AGE_WINDOW=3600; fi
	if (( AGE_WINDOW > AGE_WINDOW_CEILING_SECONDS )); then AGE_WINDOW=${AGE_WINDOW_CEILING_SECONDS}; fi
	MAX_EVIDENCE_AGE_SECONDS=${AGE_WINDOW}
else
	MAX_EVIDENCE_AGE_SECONDS=3600
fi

has_ftype() {
	local ftype="$1"
	if [[ ! -f "${EVIDENCE_FILE}" ]]; then
		echo "false"
		return
	fi
	local found
	found=$(jq -r --arg t "${ftype}" --argjson now "${NOW}" --argjson window "${MAX_EVIDENCE_AGE_SECONDS}" --arg sha "${CURRENT_SHA}" '
		.entries // []
		| map(select(
			.type == $t
			and (
				(now - ((.timestamp // "1970-01-01T00:00:00Z") | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime))
				<= $window
			)
			and (
				($sha == "")
				or (.plan_sha256 == $sha)
				or ((.output_snippet // "") | test("plan_sha256:" + $sha))
			)
			and ((.verified_by // "") | test("^(oracle|executor)$"))
			and (.exit_code == 0)
		))
		| length > 0
	' "${EVIDENCE_FILE}")
	echo "${found}"
}

# Diagnose why a specific F-type entry failed validation — returns a human-readable cause.
# Checks entries that match type + SHA but fail verified_by or exit_code constraints.
_ftype_rejection_cause() {
	local ftype="$1"
	if [[ ! -f "${EVIDENCE_FILE}" ]]; then
		echo ""
		return
	fi
	jq -r --arg t "${ftype}" --argjson now "${NOW}" --argjson window "${MAX_EVIDENCE_AGE_SECONDS}" --arg sha "${CURRENT_SHA}" '
		.entries // []
		| map(select(
			.type == $t
			and (
				(now - ((.timestamp // "1970-01-01T00:00:00Z") | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime))
				<= $window
			)
			and (
				($sha == "")
				or (.plan_sha256 == $sha)
				or ((.output_snippet // "") | test("plan_sha256:" + $sha))
			)
		))
		| if length == 0 then ""
		  else
		    map(
		      if ((.verified_by // "") | test("^(oracle|executor)$") | not) then
		        "entry rejected: verified_by must be '\''oracle'\'' or '\''executor'\'' (got '\''" + (.verified_by // "") + "'\'')"
		      elif .exit_code != 0 then
		        "entry rejected: exit_code != 0"
		      else "" end
		    )
		    | map(select(. != ""))
		    | first // ""
		  end
	' "${EVIDENCE_FILE}"
}

F1=$(has_ftype "final_verification_f1")
F2=$(has_ftype "final_verification_f2")
F3=$(has_ftype "final_verification_f3")
F4=$(has_ftype "final_verification_f4")

MISSING=""
[[ "${F1}" != "true" ]] && MISSING="${MISSING} final_verification_f1"
[[ "${F2}" != "true" ]] && MISSING="${MISSING} final_verification_f2"
[[ "${F3}" != "true" ]] && MISSING="${MISSING} final_verification_f3"
[[ "${F4}" != "true" ]] && MISSING="${MISSING} final_verification_f4"

if [[ -n "${MISSING}" ]]; then
	MISSING="${MISSING# }"
	# Consecutive-block cap (mirrors ralph-persistence.sh, which this hook previously
	# lacked). An unsatisfiable same-session orphan obligation must not block Stop
	# unboundedly. Count consecutive blocks keyed by plan SHA (a SHA change resets); at
	# cap, allow stop (fail-open) but RETAIN the marker so a later legitimate Stop nudges.
	STOP_BLOCK_CAP="${CLAUDE_CODE_STOP_HOOK_BLOCK_CAP:-8}"
	FV_CAP_STATE="${STATE_DIR}/final-verify-cap-state.json"
	FV_PREV_SHA=$(jq_read "${FV_CAP_STATE}" '.plan_sha256 // ""')
	FV_CNT=$(jq_read "${FV_CAP_STATE}" '.block_count // 0')
	[[ "${FV_PREV_SHA}" != "${CURRENT_SHA}" ]] && FV_CNT=0
	FV_CNT=$(( FV_CNT + 1 ))
	_fv_tmp=$(mktemp) && jq -n --arg sha "${CURRENT_SHA}" --argjson c "${FV_CNT}" \
		'{plan_sha256: $sha, block_count: $c}' > "${_fv_tmp}" && mv "${_fv_tmp}" "${FV_CAP_STATE}"
	if [[ "${FV_CNT}" -ge "${STOP_BLOCK_CAP}" ]]; then
		log_hook_error "final-verification yielding at block_count=${FV_CNT} (cap=${STOP_BLOCK_CAP}) — allowing stop, marker retained" "final-verification-evidence.sh"
		echo "[FINAL VERIFICATION] F1-F4 evidence still missing after ${FV_CNT} Stop attempts — yielding to avoid an inescapable loop. To resolve: mode_clear(mode=\"final_verify\"), or set OMCA_HOOK_DISABLE_FINAL_VERIFY=1, or log evidence with plan_sha256:${CURRENT_SHA}. Marker retained for a later Stop." >&2
		noop_exit
	fi
	# For each missing F-type, check whether a candidate entry exists but was rejected
	# due to bad verified_by or non-zero exit_code, and surface the cause.
	REJECTION_DETAIL=""
	for _ftype in final_verification_f1 final_verification_f2 final_verification_f3 final_verification_f4; do
		case "${_ftype}" in
			final_verification_f1) [[ "${F1}" == "true" ]] && continue ;;
			final_verification_f2) [[ "${F2}" == "true" ]] && continue ;;
			final_verification_f3) [[ "${F3}" == "true" ]] && continue ;;
			final_verification_f4) [[ "${F4}" == "true" ]] && continue ;;
			*) continue ;;
		esac
		_cause=$(_ftype_rejection_cause "${_ftype}")
		if [[ -n "${_cause}" ]]; then
			REJECTION_DETAIL="${REJECTION_DETAIL} ${_ftype} ${_cause};"
		fi
	done
	REJECTION_DETAIL="${REJECTION_DETAIL# }"
	if [[ -n "${REJECTION_DETAIL}" ]]; then
		echo "[FINAL VERIFICATION] Plan complete but F1-F4 evidence missing: ${MISSING}. Rejection detail: ${REJECTION_DETAIL}" >&2
	else
		echo "[FINAL VERIFICATION] Plan complete but F1-F4 evidence missing: ${MISSING}. Run the Final Verification Wave per agents/sisyphus.md or commands/start-work.md and call evidence_log(evidence_type=\"<type>\", command=\"oracle: APPROVE\", exit_code=0, output_snippet=\"plan_sha256:<sha> verdict:APPROVE\") for each." >&2
	fi
	exit 2
fi

# All 4 F-types present — validate all F1-F4 entries that belong to the current plan
# share a single SHA. Extract SHA from first-class field AND snippet, then unique.
# Entries from prior plans (different SHA) are ignored: they didn't satisfy has_ftype.
# When marker.marked_at is available, only consider entries timestamped >= marker_iso
# to avoid false-positive SHA-divergence from evidence written for a previous plan run.
SHAS=$(jq -r --arg sha "${CURRENT_SHA}" --arg marker_iso "${MARKER_AT_ISO}" '
	.entries // []
	| map(select(.type | test("^final_verification_f[1-4]$")))
	| map(select(
		($marker_iso == "")
		or ((.timestamp // "") >= $marker_iso)
	))
	| map(
		[(.plan_sha256 // empty)]
		+ [(.output_snippet // "" | scan("plan_sha256:[a-f0-9]{64}") | sub("plan_sha256:"; ""))]
		| unique
		| .[]
	)
	| map(select(. == $sha or $sha == ""))
	| unique
	| @json
' "${EVIDENCE_FILE}")

SHA_COUNT=$(jq 'length' <<< "${SHAS}")
SHA_COUNT="${SHA_COUNT:-0}"

if [[ "${SHA_COUNT}" -gt 1 ]]; then
	echo "[FINAL VERIFICATION] Stale evidence from a prior plan detected. Current-plan SHA: ${CURRENT_SHA}. Use evidence_read to inspect .omca/evidence/verification-evidence.json if confirmed stale." >&2
	exit 2
fi

if [[ -f "${MARKER_FILE}" ]] && [[ -n "${CURRENT_SHA}" ]] && [[ "${SHA_COUNT}" -le 1 ]]; then
	rm -f "${MARKER_FILE}"
	# Evidence satisfied — reset the consecutive-block cap counter.
	rm -f "${STATE_DIR}/final-verify-cap-state.json"
fi

noop_exit
