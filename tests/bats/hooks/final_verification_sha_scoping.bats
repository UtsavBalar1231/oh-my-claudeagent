#!/usr/bin/env bats
# Regression tests for plan_sha256 scoping in final-verification-evidence.sh.
# Covers: first-class field match, mixed legacy+current, missing F4, legacy snippet-only back-compat.

load '../test_helper'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_write_complete_plan() {
	local plan_path="$1"
	printf '%s\n' \
		'# SHA Scoping Test Plan' \
		'' \
		'## Tasks' \
		'' \
		'- [x] 1. Task alpha' \
		'- [x] 2. Task beta' \
		'- [x] 3. Task gamma' \
		> "${plan_path}"
}

_write_boulder_for() {
	local plan_path="$1"
	write_state "boulder.json" \
		"{\"active_plan\":\"${plan_path}\",\"status\":\"active\"}"
}

_write_marker_for() {
	local plan_path="$1"
	local now
	now=$(date +%s)
	write_state "pending-final-verify.json" \
		"{\"plan_path\":\"${plan_path}\",\"plan_sha256\":\"\",\"marked_at\":${now},\"session_id\":\"bats-test-session\"}"
}

_compute_sha256() {
	local plan_path="$1"
	sha256sum "${plan_path}" | awk '{print $1}'
}

# Write evidence.json with 4 F-steps using first-class plan_sha256 field.
_write_firstclass_ftypes() {
	local sha="$1"
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local entries
	entries=$(jq -n \
		--arg ts "${ts}" \
		--arg sha "${sha}" \
		'[
			{"type":"final_verification_f1","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$ts,"plan_sha256":$sha},
			{"type":"final_verification_f2","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$ts,"plan_sha256":$sha},
			{"type":"final_verification_f3","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$ts,"plan_sha256":$sha},
			{"type":"final_verification_f4","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$ts,"plan_sha256":$sha}
		]')
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "{\"entries\":${entries}}" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"
}

# Write evidence.json: 4 current F-steps with first-class field + 2 legacy entries with no first-class field.
_write_mixed_evidence() {
	local sha="$1"
	local other_sha="cafebabe00000000cafebabe00000000cafebabe00000000cafebabe00000000"
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local entries
	entries=$(jq -n \
		--arg ts "${ts}" \
		--arg sha "${sha}" \
		--arg other "${other_sha}" \
		'[
			{"type":"final_verification_f1","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$ts,"plan_sha256":$sha},
			{"type":"final_verification_f2","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$ts,"plan_sha256":$sha},
			{"type":"final_verification_f3","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$ts,"plan_sha256":$sha},
			{"type":"final_verification_f4","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$ts,"plan_sha256":$sha},
			{"type":"final_verification_f1","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $other + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f2","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $other + " verdict:APPROVE"),"timestamp":$ts}
		]')
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "{\"entries\":${entries}}" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"
}

# Write evidence.json with only F1-F3 using first-class field, no F4.
_write_firstclass_no_f4() {
	local sha="$1"
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local entries
	entries=$(jq -n \
		--arg ts "${ts}" \
		--arg sha "${sha}" \
		'[
			{"type":"final_verification_f1","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$ts,"plan_sha256":$sha},
			{"type":"final_verification_f2","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$ts,"plan_sha256":$sha},
			{"type":"final_verification_f3","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$ts,"plan_sha256":$sha}
		]')
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "{\"entries\":${entries}}" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"
}

# Write evidence.json with 4 F-steps using legacy output_snippet embedding only (no first-class field).
_write_legacy_snippet_ftypes() {
	local sha="$1"
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local entries
	entries=$(jq -n \
		--arg ts "${ts}" \
		--arg sha "${sha}" \
		'[
			{"type":"final_verification_f1","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f2","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f3","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f4","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts}
		]')
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "{\"entries\":${entries}}" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"
}

# ---------------------------------------------------------------------------
# Test 1: Fresh plan, all F1-F4 carry matching first-class plan_sha256 → exit 0
# ---------------------------------------------------------------------------

@test "sha-scoping: all F1-F4 with matching first-class plan_sha256 field passes (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/fresh-plan.md"
	_write_complete_plan "${plan_file}"
	local sha
	sha=$(_compute_sha256 "${plan_file}")

	_write_boulder_for "${plan_file}"
	_write_firstclass_ftypes "${sha}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# Test 2: Mixed entries — 4 current first-class + 2 stale legacy-bucket → exit 0
# ---------------------------------------------------------------------------

@test "sha-scoping: current first-class F1-F4 plus stale legacy entries passes (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/mixed-plan.md"
	_write_complete_plan "${plan_file}"
	local sha
	sha=$(_compute_sha256 "${plan_file}")

	_write_boulder_for "${plan_file}"
	_write_mixed_evidence "${sha}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# Test 3: F1-F3 present with first-class field, F4 missing → exit 2, names F4
# ---------------------------------------------------------------------------

@test "sha-scoping: missing F4 with first-class field present blocks Stop (exit 2) and names F4" {
	local plan_file="${BATS_TEST_TMPDIR}/no-f4-plan.md"
	_write_complete_plan "${plan_file}"
	local sha
	sha=$(_compute_sha256 "${plan_file}")

	_write_boulder_for "${plan_file}"
	_write_marker_for "${plan_file}"
	_write_firstclass_no_f4 "${sha}"

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "final_verification_f4"
}

# ---------------------------------------------------------------------------
# Test 4: F1-F4 all via legacy output_snippet embedding only (no first-class field) → exit 0
# ---------------------------------------------------------------------------

@test "sha-scoping: legacy output_snippet embedding only (no first-class field) passes (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/legacy-plan.md"
	_write_complete_plan "${plan_file}"
	local sha
	sha=$(_compute_sha256 "${plan_file}")

	_write_boulder_for "${plan_file}"
	_write_legacy_snippet_ftypes "${sha}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# Test 5: Pre-marker entry with a distinct old SHA + marker + post-marker F1-F4
#          → SHA-divergence check must NOT flag the old entry (exit 0).
# ---------------------------------------------------------------------------

@test "sha-scoping: pre-marker entry with different SHA is excluded from divergence check (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/marker-scope-plan.md"
	_write_complete_plan "${plan_file}"
	local sha
	sha=$(_compute_sha256 "${plan_file}")

	_write_boulder_for "${plan_file}"

	# Marker written NOW; pre-marker evidence will be timestamped one day earlier.
	local now_epoch
	now_epoch=$(date +%s)
	local old_ts
	old_ts=$(date -u -d "@$(( now_epoch - 86400 ))" +%Y-%m-%dT%H:%M:%SZ)
	local new_ts
	new_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local old_sha="0000000000000000000000000000000000000000000000000000000000000001"

	# Write marker with marked_at = now_epoch (after the old entry, before the new entries).
	write_state "pending-final-verify.json" \
		"{\"plan_path\":\"${plan_file}\",\"plan_sha256\":\"${sha}\",\"marked_at\":${now_epoch},\"session_id\":\"bats-test-session\"}"

	# Evidence: one pre-marker entry with old_sha, then 4 post-marker F-type entries with current sha.
	local entries
	entries=$(jq -n \
		--arg old_ts "${old_ts}" \
		--arg new_ts "${new_ts}" \
		--arg sha "${sha}" \
		--arg old_sha "${old_sha}" \
		'[
			{"type":"final_verification_f1","command":"old run","exit_code":0,"output_snippet":("plan_sha256:" + $old_sha + " verdict:APPROVE"),"timestamp":$old_ts,"verified_by":"oracle"},
			{"type":"final_verification_f1","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$new_ts,"plan_sha256":$sha,"verified_by":"oracle"},
			{"type":"final_verification_f2","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$new_ts,"plan_sha256":$sha,"verified_by":"executor"},
			{"type":"final_verification_f3","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$new_ts,"plan_sha256":$sha,"verified_by":"executor"},
			{"type":"final_verification_f4","command":"oracle: APPROVE","exit_code":0,"output_snippet":"verdict:APPROVE","timestamp":$new_ts,"plan_sha256":$sha,"verified_by":"executor"}
		]')
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "{\"entries\":${entries}}" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# Test 6: Marker absent — full-log SHA scan (unchanged behavior).
#          All F1-F4 entries share the current SHA → exit 0 regardless.
# ---------------------------------------------------------------------------

@test "sha-scoping: marker absent — full-log SHA scan still passes (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/no-marker-plan.md"
	_write_complete_plan "${plan_file}"
	local sha
	sha=$(_compute_sha256 "${plan_file}")

	_write_boulder_for "${plan_file}"
	# No marker written — MARKER_AT_ISO will be empty, full log is scanned.
	_write_firstclass_ftypes "${sha}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}
