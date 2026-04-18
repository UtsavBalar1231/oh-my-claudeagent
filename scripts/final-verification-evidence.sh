#!/bin/bash
# final-verification-evidence.sh — blocks Stop when a completed plan lacks F1-F4 evidence.
# F-types: final_verification_f1..f4 (plan compliance, code quality, manual QA, scope fidelity).
# Entries need plan_sha256:<hex> in output_snippet; all 4 must share the same SHA.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"
STATE_DIR="${HOOK_STATE_DIR}"

MAX_EVIDENCE_AGE_SECONDS=3600
MAX_MARKER_AGE_SECONDS=86400

_noop_exit() {
	printf '{}\n'
	exit 0
}

# Kill switch for emergency rollback
if [[ "${OMCA_HOOK_DISABLE_FINAL_VERIFY:-}" == "1" ]]; then
	echo "[FINAL VERIFICATION] Kill switch active (OMCA_HOOK_DISABLE_FINAL_VERIFY=1) — skipping F1-F4 check." >&2
	_noop_exit
fi

# Recursion guard
STOP_HOOK_ACTIVE=$(echo "${INPUT}" | jq -r '.stop_hook_active // false' 2>/dev/null || echo "false")
if [[ "${STOP_HOOK_ACTIVE}" == "true" ]]; then
	_noop_exit
fi

BOULDER_FILE="${STATE_DIR}/boulder.json"
MARKER_FILE="${STATE_DIR}/pending-final-verify.json"
EVIDENCE_FILE="${STATE_DIR}/verification-evidence.json"

# Determine whether enforcement applies via active boulder or persistent marker
ACTIVE_PLAN=""
if [[ -f "${BOULDER_FILE}" ]]; then
	ACTIVE_PLAN=$(jq -r '.active_plan // ""' "${BOULDER_FILE}" 2>/dev/null || echo "")
fi

MARKER_PLAN=""
MARKER_AT=0
if [[ -f "${MARKER_FILE}" ]]; then
	MARKER_PLAN=$(jq -r '.plan_path // ""' "${MARKER_FILE}" 2>/dev/null || echo "")
	MARKER_AT=$(jq -r '.marked_at // 0' "${MARKER_FILE}" 2>/dev/null || echo "0")
fi

# No active plan and no fresh marker — regular session, do not block
if [[ -z "${ACTIVE_PLAN}" && -z "${MARKER_PLAN}" ]]; then
	_noop_exit
fi

# Resolve which plan path to inspect
PLAN_PATH="${ACTIVE_PLAN}"
if [[ -z "${PLAN_PATH}" ]]; then
	PLAN_PATH="${MARKER_PLAN}"
fi

CURRENT_SHA=""
if [[ -n "${PLAN_PATH}" ]] && [[ -f "${PLAN_PATH}" ]]; then
	CURRENT_SHA=$(sha256sum "${PLAN_PATH}" 2>/dev/null | awk '{print $1}' || echo "")
fi

# Count checkboxes only when active plan exists and plan file is readable
INCOMPLETE=0
COMPLETE=0
if [[ -n "${ACTIVE_PLAN}" && -f "${ACTIVE_PLAN}" ]]; then
	INCOMPLETE=$(grep -cE '^- \[ \] ' "${ACTIVE_PLAN}" 2>/dev/null || true)
	INCOMPLETE="${INCOMPLETE:-0}"
	COMPLETE=$(grep -cE '^- \[x\] ' "${ACTIVE_PLAN}" 2>/dev/null || true)
	COMPLETE="${COMPLETE:-0}"
fi

# If checkboxes are still pending, let ralph-persistence handle it
if [[ "${INCOMPLETE}" -gt 0 ]]; then
	_noop_exit
fi

# If no active boulder but marker is present — check marker freshness
if [[ -z "${ACTIVE_PLAN}" && -n "${MARKER_PLAN}" ]]; then
	NOW=$(date +%s)
	MARKER_AGE=$(( NOW - MARKER_AT ))
	if [[ "${MARKER_AGE}" -gt "${MAX_MARKER_AGE_SECONDS}" ]]; then
		# Stale marker — do not block
		_noop_exit
	fi
	# Fresh marker without active plan → /stop-continuation bypass attempt; fall through to evidence check
fi

# Only enforce when plan is fully checked off OR marker is present (no active boulder path)
if [[ "${INCOMPLETE}" -eq 0 && "${COMPLETE}" -eq 0 && -z "${MARKER_PLAN}" ]]; then
	_noop_exit
fi

# Fail-closed on corrupt evidence file
if [[ -f "${EVIDENCE_FILE}" ]]; then
	if ! jq -e '.entries | arrays' "${EVIDENCE_FILE}" >/dev/null 2>&1; then
		echo "[FINAL VERIFICATION] Evidence file corrupt — refusing to allow Stop until manually repaired." >&2
		exit 2
	fi
fi

NOW=$(date +%s)

# Check for each F-type within the time window
_has_ftype() {
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
				or (.plan_sha256 == null or .plan_sha256 == "")
			)
		))
		| length > 0
	' "${EVIDENCE_FILE}" 2>/dev/null || echo "false")
	echo "${found}"
}

F1=$(_has_ftype "final_verification_f1")
F2=$(_has_ftype "final_verification_f2")
F3=$(_has_ftype "final_verification_f3")
F4=$(_has_ftype "final_verification_f4")

MISSING=""
[[ "${F1}" != "true" ]] && MISSING="${MISSING} final_verification_f1"
[[ "${F2}" != "true" ]] && MISSING="${MISSING} final_verification_f2"
[[ "${F3}" != "true" ]] && MISSING="${MISSING} final_verification_f3"
[[ "${F4}" != "true" ]] && MISSING="${MISSING} final_verification_f4"

if [[ -n "${MISSING}" ]]; then
	# Trim leading space
	MISSING="${MISSING# }"
	echo "[FINAL VERIFICATION] Plan complete but F1-F4 evidence missing: ${MISSING}. Run the Final Verification Wave per agents/sisyphus.md or commands/start-work.md and call evidence_log(evidence_type=\"<type>\", command=\"oracle: APPROVE\", exit_code=0, output_snippet=\"plan_sha256:<sha> verdict:APPROVE\") for each." >&2
	exit 2
fi

# All 4 F-types present — validate legacy-unknown entries (no first-class plan_sha256 field) all share the same SHA
SHAS=$(jq -r --arg sha "${CURRENT_SHA}" '
	.entries // []
	| map(select(.type | test("^final_verification_f[1-4]$")))
	| map(select(.plan_sha256 == null or .plan_sha256 == ""))
	| map(.output_snippet | capture("plan_sha256:(?<sha>[0-9a-f]+)").sha // "")
	| unique
	| @json
' "${EVIDENCE_FILE}" 2>/dev/null || echo '[""]')

SHA_COUNT=$(echo "${SHAS}" | jq 'length' 2>/dev/null || echo "0")
SHA_COUNT="${SHA_COUNT:-0}"

if [[ "${SHA_COUNT}" -gt 1 ]]; then
	echo "[FINAL VERIFICATION] Stale evidence from a prior plan detected. Current-plan SHA: ${CURRENT_SHA}. Use evidence_read to inspect or prune .omca/state/evidence.jsonl if confirmed stale." >&2
	exit 2
fi

_noop_exit
