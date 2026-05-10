#!/bin/bash
# final-verification-evidence.sh — blocks Stop when a completed plan lacks F1-F4 evidence.
# F-types: final_verification_f1..f4 (plan compliance, code quality, manual QA, scope fidelity).
# Entries need plan_sha256:<hex> in output_snippet; all 4 must share the same SHA.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

# 3600s (1h) — F1-F4 freshness; sibling task-completed-verify uses 300s. UNDOCUMENTED.
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
EVIDENCE_FILE="${STATE_DIR}/verification-evidence.json"

ACTIVE_PLAN=$(jq_read "${BOULDER_FILE}" '.active_plan // ""')

MARKER_PLAN=$(jq_read "${MARKER_FILE}" '.plan_path // ""')
MARKER_AT=$(jq_read "${MARKER_FILE}" '.marked_at // 0')

if [[ -z "${ACTIVE_PLAN}" && -z "${MARKER_PLAN}" ]]; then
	noop_exit
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
		SIDECAR_PATH=$(compute_sidecar_path "${MARKER_PLAN}")
		if sidecar_sha_matches "${SIDECAR_PATH}" "${MARKER_SHA}"; then
			rm -f "${MARKER_FILE}"
			noop_exit
		fi
	fi

	# Marker plan has zero [x] — never started, stale.
	if [[ -n "${MARKER_PLAN}" && -f "${MARKER_PLAN}" ]]; then
		MARKER_DONE=$(grep -cE '^- \[x\] ' "${MARKER_PLAN}" 2>/dev/null || true)
		MARKER_DONE="${MARKER_DONE:-0}"
		if [[ "${MARKER_DONE}" -eq 0 ]]; then
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
	log_hook_error "cleared cross-session stale active_plan reference (no marker)" "final-verification-evidence.sh"
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
	MARKER_AGE=$(( NOW - MARKER_AT ))
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
		))
		| length > 0
	' "${EVIDENCE_FILE}")
	echo "${found}"
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
	echo "[FINAL VERIFICATION] Plan complete but F1-F4 evidence missing: ${MISSING}. Run the Final Verification Wave per agents/sisyphus.md or commands/start-work.md and call evidence_log(evidence_type=\"<type>\", command=\"oracle: APPROVE\", exit_code=0, output_snippet=\"plan_sha256:<sha> verdict:APPROVE\") for each." >&2
	exit 2
fi

# All 4 F-types present — validate all F1-F4 entries that belong to the current plan
# share a single SHA. Extract SHA from first-class field AND snippet, then unique.
# Entries from prior plans (different SHA) are ignored: they didn't satisfy has_ftype.
SHAS=$(jq -r --arg sha "${CURRENT_SHA}" '
	.entries // []
	| map(select(.type | test("^final_verification_f[1-4]$")))
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
	echo "[FINAL VERIFICATION] Stale evidence from a prior plan detected. Current-plan SHA: ${CURRENT_SHA}. Use evidence_read to inspect or prune .omca/state/evidence.jsonl if confirmed stale." >&2
	exit 2
fi

if [[ -f "${MARKER_FILE}" ]] && [[ -n "${CURRENT_SHA}" ]] && [[ "${SHA_COUNT}" -le 1 ]]; then
	rm -f "${MARKER_FILE}"
fi

noop_exit
