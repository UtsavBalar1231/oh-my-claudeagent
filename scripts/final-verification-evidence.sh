#!/bin/bash
# final-verification-evidence.sh — blocks Stop when a completed plan lacks a final_verification evidence entry.
# A single logged entry of type "final_verification" (exit_code=0) opens the gate permanently (idempotency anchor).
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"

noop_exit() {
	printf '{}\n'
	exit 0
}

# Kill switch for emergency rollback
if [[ "${OMCA_HOOK_DISABLE_FINAL_VERIFY:-}" == "1" ]]; then
	echo "[FINAL VERIFICATION] Kill switch active (OMCA_HOOK_DISABLE_FINAL_VERIFY=1) — skipping check." >&2
	noop_exit
fi

# Recursion guard
STOP_HOOK_ACTIVE=$(jq -r '.stop_hook_active // false' <<< "${HOOK_INPUT}")
if [[ "${STOP_HOOK_ACTIVE}" == "true" ]]; then
	noop_exit
fi

BOULDER_FILE="${STATE_DIR}/boulder.json"
EVIDENCE_FILE=$(resolve_evidence_file "${STATE_DIR}")

ACTIVE_PLAN=$(jq_read "${BOULDER_FILE}" '.active_plan // ""')

# No active plan on record — nothing to enforce
if [[ -z "${ACTIVE_PLAN}" || ! -f "${ACTIVE_PLAN}" ]]; then
	noop_exit
fi

# Count remaining unchecked boxes; if any remain the plan is not done — allow stop
INCOMPLETE=$(grep -cE '^- \[ \] ' "${ACTIVE_PLAN}" 2>/dev/null || true)
INCOMPLETE="${INCOMPLETE:-0}"
if [[ "${INCOMPLETE}" -gt 0 ]]; then
	noop_exit
fi

# Plan is fully checked. If no checkboxes at all (empty/non-task plan), allow stop
COMPLETE=$(grep -cE '^- \[x\] ' "${ACTIVE_PLAN}" 2>/dev/null || true)
COMPLETE="${COMPLETE:-0}"
if [[ "${INCOMPLETE}" -eq 0 && "${COMPLETE}" -eq 0 ]]; then
	noop_exit
fi

# Fail-closed on corrupt evidence file
if [[ -f "${EVIDENCE_FILE}" ]]; then
	if ! jq -e '.entries | arrays' "${EVIDENCE_FILE}" >/dev/null 2>&1; then
		echo "[FINAL VERIFICATION] Evidence file corrupt — refusing to allow Stop until manually repaired." >&2
		exit 2
	fi
fi

# Check for a final_verification evidence entry (any exit_code=0 entry opens the gate permanently)
HAS_VERDICT=false
if [[ -f "${EVIDENCE_FILE}" ]]; then
	HAS_VERDICT=$(jq -r '
		.entries // []
		| map(select(.type == "final_verification" and .exit_code == 0))
		| length > 0
	' "${EVIDENCE_FILE}")
fi

if [[ "${HAS_VERDICT}" == "true" ]]; then
	noop_exit
fi

# Plan complete, no final_verification evidence — block Stop
echo "[FINAL VERIFICATION] Plan fully checked but no final_verification evidence found. Call evidence_log(evidence_type=\"final_verification\", command=\"<your verdict>\", exit_code=0, output_snippet=\"...\") to open the gate. Set OMCA_HOOK_DISABLE_FINAL_VERIFY=1 to bypass." >&2
exit 2
