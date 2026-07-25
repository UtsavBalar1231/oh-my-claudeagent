#!/bin/bash
# final-verification-evidence.sh — blocks Stop when THIS SESSION's bound plan
# (resolved strictly: an explicit boulder.json binding only, never a sole-plan
# or most-recent fallback) is complete but lacks a matching final_verification
# evidence entry (exit_code=0, plan_sha256 matches the bound plan's current
# bytes, or a legacy entry with no plan_sha256 field — backward-compat with
# evidence logged before scoping existed). An unbound session is never
# blocked on a plan it has no relationship to.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

STATE_DIR="${HOOK_STATE_DIR}"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"

noop_exit() {
	printf '{}\n'
	exit 0
}

# Unified kill switch (also honors the legacy OMCA_HOOK_DISABLE_FINAL_VERIFY below)
if hook_is_disabled "final-verification-evidence"; then
	echo "[FINAL VERIFICATION] Disabled via OMCA_DISABLED_HOOKS, skipping check." >&2
	noop_exit
fi

# stdin read timed out: HOOK_INPUT is empty/unreliable, so stop_hook_active and
# plan-completeness signals below cannot be trusted. Warn and allow the Stop —
# trapping the session on an unreadable signal is worse than an unenforced gate.
if [[ "${HOOK_INPUT_TIMED_OUT:-0}" -eq 1 ]]; then
	echo "[FINAL VERIFICATION] stdin read timed out — cannot evaluate plan completeness this Stop. Allowing." >&2
	noop_exit
fi

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

EVIDENCE_FILE=$(resolve_evidence_file "${STATE_DIR}")

# A registry that exists but does not parse resolves to `{}`, the same result
# as no registry at all, which would read as "no bound plan" and disable this
# gate invisibly. Say so on stderr; plan-continuation-guard.sh is the gate that
# refuses the stop on this condition, so this one does not block too.
if [[ -f "${STATE_DIR}/boulder.json" ]] && ! jq -e . "${STATE_DIR}/boulder.json" >/dev/null 2>&1; then
	log_hook_error "boulder.json is not valid JSON, plan state unresolvable" "$(basename "$0")"
	echo "[FINAL VERIFICATION] ${STATE_DIR}/boulder.json is not valid JSON, so no plan resolves and this gate is not enforcing. Repair or delete the file." >&2
fi

# Resolve via the shared shim (never hand-parse boulder.json), --strict: only
# an explicit binding resolves, `{}` when the registry is empty or this
# session was never bound to anything — an unbound session must never be
# blocked on a plan it has no relationship to.
BOULDER_RESOLVED=$(python3 "${PLUGIN_ROOT}/servers/tools/boulder_resolve.py" "$(resolve_session_id)" "${HOOK_PROJECT_ROOT}" --strict 2>/dev/null)
ACTIVE_PLAN=$(jq -r '.active_plan // ""' <<< "${BOULDER_RESOLVED:-{\}}" 2>/dev/null)

# No bound plan on record — nothing to enforce
if [[ -z "${ACTIVE_PLAN}" || ! -f "${ACTIVE_PLAN}" ]]; then
	noop_exit
fi

# Count remaining unchecked boxes via the shared helper (agrees with boulder_progress
# and statusline, which both count only numbered `- [ ] N.` boxes); if any remain
# the plan is not done: allow stop
read -r INCOMPLETE COMPLETE _TOTAL _RAW_UNCHECKED < <(count_plan_checkboxes "${ACTIVE_PLAN}")
if [[ "${INCOMPLETE}" -gt 0 ]]; then
	noop_exit
fi

# Plan is fully checked. If no checkboxes at all (empty/non-task plan), allow stop
if [[ "${INCOMPLETE}" -eq 0 && "${COMPLETE}" -eq 0 ]]; then
	noop_exit
fi

# Fail-closed on corrupt evidence file
if [[ -f "${EVIDENCE_FILE}" ]]; then
	if ! jq -e '.entries | arrays' "${EVIDENCE_FILE}" >/dev/null 2>&1; then
		block_exit "[FINAL VERIFICATION] Evidence file corrupt. Repair ${EVIDENCE_FILE} before stopping."
	fi
fi

PLAN_SHA256=$(sha256sum "${ACTIVE_PLAN}" | awk '{print $1}')

# Check for a final_verification entry that opens the gate: exit_code=0, and
# either scoped to this exact plan (plan_sha256 matches) or a pre-scoping
# legacy entry (no plan_sha256 field at all).
HAS_VERDICT=false
if [[ -f "${EVIDENCE_FILE}" ]]; then
	HAS_VERDICT=$(jq -r --arg sha "${PLAN_SHA256}" '
		.entries // []
		| map(select(
			.type == "final_verification"
			and .exit_code == 0
			and ((.plan_sha256 // "") == "" or .plan_sha256 == $sha)
		))
		| length > 0
	' "${EVIDENCE_FILE}")
fi

if [[ "${HAS_VERDICT}" == "true" ]]; then
	noop_exit
fi

# Plan complete, no matching final_verification evidence — block Stop
block_exit "[FINAL VERIFICATION] Plan '${ACTIVE_PLAN}' fully checked but no matching final_verification evidence found. Call evidence_log(evidence_type=\"final_verification\", command=\"<your verdict>\", exit_code=0, output_snippet=\"...\", plan_sha256=\"${PLAN_SHA256}\") to open the gate. Set OMCA_HOOK_DISABLE_FINAL_VERIFY=1 to bypass."
