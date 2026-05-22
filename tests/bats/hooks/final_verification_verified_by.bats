#!/usr/bin/env bats
# Tests for verified_by and exit_code enforcement on F1-F4 entries in
# final-verification-evidence.sh (Task 11 — Item 10).
# Predicate: verified_by ∈ {oracle, executor} AND exit_code == 0.

load '../test_helper'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_write_complete_plan() {
	local plan_path="$1"
	printf '%s\n' \
		'# Verified-By Test Plan' \
		'' \
		'## Tasks' \
		'' \
		'- [x] 1. Task alpha' \
		'- [x] 2. Task beta' \
		'- [x] 3. Task gamma' \
		> "${plan_path}"
}

_compute_sha256() {
	sha256sum "$1" | awk '{print $1}'
}

_write_boulder_for() {
	local plan_path="$1"
	write_state "boulder.json" \
		"{\"active_plan\":\"${plan_path}\",\"status\":\"active\"}"
}

_write_marker_for() {
	local plan_path="$1"
	local sha="$2"
	local now
	now=$(date +%s)
	write_state "pending-final-verify.json" \
		"{\"plan_path\":\"${plan_path}\",\"plan_sha256\":\"${sha}\",\"marked_at\":${now},\"session_id\":\"bats-test-session\"}"
}

# Build a single F-entry JSON object.
_fentry() {
	local ftype="$1" verified_by="$2" exit_code="$3" sha="$4"
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	jq -n \
		--arg t "${ftype}" \
		--arg vb "${verified_by}" \
		--argjson ec "${exit_code}" \
		--arg ts "${ts}" \
		--arg sha "${sha}" \
		'{"type":$t,"command":"oracle: APPROVE","exit_code":$ec,"output_snippet":"verdict:APPROVE","timestamp":$ts,"plan_sha256":$sha,"verified_by":$vb}'
}

# ---------------------------------------------------------------------------
# Test 1 — F1 has verified_by="momus" (not in allowed set) → exit 2, names F1 + verified_by cause
# ---------------------------------------------------------------------------

@test "verified_by: F1 with verified_by=momus rejected (exit 2, names F1 and verified_by cause)" {
	local plan_file="${BATS_TEST_TMPDIR}/vb-momus-plan.md"
	_write_complete_plan "${plan_file}"
	local sha
	sha=$(_compute_sha256 "${plan_file}")

	_write_boulder_for "${plan_file}"
	_write_marker_for "${plan_file}" "${sha}"

	# F1 has bad verified_by; F2/F3/F4 are valid.
	local entries
	entries=$(jq -n \
		--argjson f1 "$(_fentry final_verification_f1 momus 0 "${sha}")" \
		--argjson f2 "$(_fentry final_verification_f2 executor 0 "${sha}")" \
		--argjson f3 "$(_fentry final_verification_f3 executor 0 "${sha}")" \
		--argjson f4 "$(_fentry final_verification_f4 oracle 0 "${sha}")" \
		'[$f1, $f2, $f3, $f4]')
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "{\"entries\":${entries}}" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "final_verification_f1"
	echo "$output" | grep -qi "verified_by"
}

# ---------------------------------------------------------------------------
# Test 2 — F1 valid (verified_by=oracle), but exit_code=1 → exit 2, names F1 + exit_code cause
# ---------------------------------------------------------------------------

@test "verified_by: F1 with exit_code=1 rejected (exit 2, names F1 and exit_code cause)" {
	local plan_file="${BATS_TEST_TMPDIR}/vb-exitcode-plan.md"
	_write_complete_plan "${plan_file}"
	local sha
	sha=$(_compute_sha256 "${plan_file}")

	_write_boulder_for "${plan_file}"
	_write_marker_for "${plan_file}" "${sha}"

	# F1 has exit_code=1 with otherwise-valid verified_by=oracle; F2/F3/F4 are valid.
	local entries
	entries=$(jq -n \
		--argjson f1 "$(_fentry final_verification_f1 oracle 1 "${sha}")" \
		--argjson f2 "$(_fentry final_verification_f2 executor 0 "${sha}")" \
		--argjson f3 "$(_fentry final_verification_f3 executor 0 "${sha}")" \
		--argjson f4 "$(_fentry final_verification_f4 oracle 0 "${sha}")" \
		'[$f1, $f2, $f3, $f4]')
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "{\"entries\":${entries}}" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "final_verification_f1"
	echo "$output" | grep -qi "exit_code"
}

# ---------------------------------------------------------------------------
# Test 3 — All four entries valid (verified_by ∈ {oracle,executor}, exit_code=0) → exit 0
# ---------------------------------------------------------------------------

@test "verified_by: all F1-F4 valid (oracle/executor, exit_code=0) passes (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/vb-allvalid-plan.md"
	_write_complete_plan "${plan_file}"
	local sha
	sha=$(_compute_sha256 "${plan_file}")

	_write_boulder_for "${plan_file}"

	local entries
	entries=$(jq -n \
		--argjson f1 "$(_fentry final_verification_f1 oracle 0 "${sha}")" \
		--argjson f2 "$(_fentry final_verification_f2 executor 0 "${sha}")" \
		--argjson f3 "$(_fentry final_verification_f3 executor 0 "${sha}")" \
		--argjson f4 "$(_fentry final_verification_f4 oracle 0 "${sha}")" \
		'[$f1, $f2, $f3, $f4]')
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "{\"entries\":${entries}}" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}
