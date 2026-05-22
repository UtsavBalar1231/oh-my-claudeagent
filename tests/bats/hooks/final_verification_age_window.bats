#!/usr/bin/env bats
# Behavioral tests for the dynamic evidence age window in final-verification-evidence.sh.
# Task 10: age window is derived from marker lifetime (now - marker.marked_at), capped at 7d.
# Fallback: 3600s when marked_at == 0 or malformed (missing field).

load '../test_helper'

NOW=$(date +%s)

# Write a plan file with all checkboxes complete; echoes the SHA to stdout
_write_complete_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# Age Window Test Plan

## TODOs

- [x] 1. First task
- [x] 2. Second task
- [x] 3. Third task
EOF
	sha256sum "${plan_path}" | awk '{print $1}'
}

# Write a pending-final-verify.json marker with the given marked_at epoch
# Usage: _write_marker <plan_path> <marked_at> [session_id] [plan_sha256]
_write_marker() {
	local plan_path="$1"
	local marked_at="$2"
	local session_id="${3:-bats-test-session}"
	local plan_sha="$4"
	write_state "pending-final-verify.json" \
		"{\"plan_path\":\"${plan_path}\",\"plan_sha256\":\"${plan_sha}\",\"marked_at\":${marked_at},\"session_id\":\"${session_id}\"}"
}

# Write F1-F4 evidence entries with the given timestamp (ISO-8601) and plan SHA
# Usage: _write_all_ftypes_at_ts <timestamp> <plan_sha>
_write_all_ftypes_at_ts() {
	local ts="$1"
	local plan_sha="$2"
	local entries
	entries=$(jq -n --arg ts "${ts}" --arg sha "${plan_sha}" '[
		{"type":"final_verification_f1","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts,"plan_sha256":$sha,"verified_by":"oracle"},
		{"type":"final_verification_f2","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts,"plan_sha256":$sha,"verified_by":"executor"},
		{"type":"final_verification_f3","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts,"plan_sha256":$sha,"verified_by":"executor"},
		{"type":"final_verification_f4","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts,"plan_sha256":$sha,"verified_by":"executor"}
	]')
	write_state "verification-evidence.json" "{\"entries\":${entries}}"
}

# ---------------------------------------------------------------------------
# (a) Marker dated 4h ago + F1-F4 entries dated 3h ago → age_window = 4h (14400s)
#     Evidence is 3h old, within the 4h window → exit 0.
#     Without dynamic derivation this would fail at the static 3600s (1h) cap.
#     Uses marker-only mode (no boulder) to avoid the ACTIVE_PLAN-without-MARKER
#     short-circuit that fires when boulder exists without a marker.
# ---------------------------------------------------------------------------

@test "age-window: marker 4h ago + evidence 3h ago passes (would fail at static 3600s cap)" {
	local plan_file="${BATS_TEST_TMPDIR}/age-window-plan.md"
	local plan_sha
	plan_sha=$(_write_complete_plan "${plan_file}")

	# Marker written 4 hours ago (marker-only mode — no boulder written)
	local marker_at=$(( NOW - 4 * 3600 ))
	_write_marker "${plan_file}" "${marker_at}" "bats-test-session" "${plan_sha}"

	# F1-F4 evidence written 3 hours ago (within marker lifetime but outside 3600s static cap)
	local evidence_ts
	evidence_ts=$(date -u -d "@$(( NOW - 3 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)
	_write_all_ftypes_at_ts "${evidence_ts}" "${plan_sha}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (b) marked_at == 0 → epoch-1970 age exceeds MAX_MARKER_AGE_SECONDS TTL guard
#     → stale-marker noop_exit fires before evidence check → exit 0.
#     The 3600s fallback in the derivation block is never reached.
# ---------------------------------------------------------------------------

@test "age-window: marked_at=0 triggers stale-marker TTL guard (exit 0, not evidence check)" {
	local plan_file="${BATS_TEST_TMPDIR}/zero-marked-at-plan.md"
	local plan_sha
	plan_sha=$(_write_complete_plan "${plan_file}")

	# Marker with marked_at == 0; no boulder — marker-only mode
	_write_marker "${plan_file}" "0" "bats-test-session" "${plan_sha}"

	# No evidence — would block if evidence check were reached
	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (c) Marker file present but marked_at field missing → jq '.marked_at // 0' = 0
#     → same path as (b): stale-marker TTL guard fires → exit 0.
# ---------------------------------------------------------------------------

@test "age-window: malformed marked_at (missing field) triggers stale-marker TTL guard (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/malformed-marker-plan.md"
	local plan_sha
	plan_sha=$(_write_complete_plan "${plan_file}")

	# Marker without marked_at field; no boulder — marker-only mode
	write_state "pending-final-verify.json" \
		"{\"plan_path\":\"${plan_file}\",\"plan_sha256\":\"${plan_sha}\",\"session_id\":\"bats-test-session\"}"

	# No evidence — would block if evidence check were reached
	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (c2) Floor at 3600s: marker written just now (age ~0) → window floored to 3600s.
#      Evidence written 30m ago is within the 3600s floor → exit 0.
# ---------------------------------------------------------------------------

@test "age-window: marker just-written floors window to 3600s; evidence 30m old passes (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/floor-plan.md"
	local plan_sha
	plan_sha=$(_write_complete_plan "${plan_file}")

	# Marker written at NOW (age ≈ 0) — marker-only mode
	_write_marker "${plan_file}" "${NOW}" "bats-test-session" "${plan_sha}"

	# F1-F4 evidence written 30m ago — within the 3600s floor
	local evidence_ts
	evidence_ts=$(date -u -d "@$(( NOW - 1800 ))" +%Y-%m-%dT%H:%M:%SZ)
	_write_all_ftypes_at_ts "${evidence_ts}" "${plan_sha}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (d) Marker dated 8 days ago → age_window capped at 7d (604800s).
#     Evidence written 6 days ago → within cap → exit 0.
#     Uses marker-only mode.
# ---------------------------------------------------------------------------

@test "age-window: marker 8d ago is capped to 7d; evidence 6d ago passes (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/ceiling-cap-plan.md"
	local plan_sha
	plan_sha=$(_write_complete_plan "${plan_file}")

	# Marker written 8 days ago — marker-only mode
	local marker_at=$(( NOW - 8 * 86400 ))
	_write_marker "${plan_file}" "${marker_at}" "bats-test-session" "${plan_sha}"

	# F1-F4 evidence written 6 days ago — within the 7d cap
	local evidence_ts
	evidence_ts=$(date -u -d "@$(( NOW - 6 * 86400 ))" +%Y-%m-%dT%H:%M:%SZ)
	_write_all_ftypes_at_ts "${evidence_ts}" "${plan_sha}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (e) Marker 30m ago + fresh evidence (5m old) → within dynamic window → exit 0
#     Baseline: both static and dynamic caps accept this; confirms no regression.
#     Uses marker-only mode.
# ---------------------------------------------------------------------------

@test "age-window: marker 30m ago + fresh evidence 5m old always passes (no regression)" {
	local plan_file="${BATS_TEST_TMPDIR}/fresh-evidence-plan.md"
	local plan_sha
	plan_sha=$(_write_complete_plan "${plan_file}")

	local marker_at=$(( NOW - 1800 ))
	_write_marker "${plan_file}" "${marker_at}" "bats-test-session" "${plan_sha}"

	local evidence_ts
	evidence_ts=$(date -u -d "@$(( NOW - 300 ))" +%Y-%m-%dT%H:%M:%SZ)
	_write_all_ftypes_at_ts "${evidence_ts}" "${plan_sha}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}
