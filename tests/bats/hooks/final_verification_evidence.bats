#!/usr/bin/env bats
# Behavioral tests for final-verification-evidence.sh — F1-F4 evidence gate on Stop.

load '../test_helper'

PLAN_SHA="deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
NOW=$(date +%s)

# Write a synthetic boulder.json pointing to a plan file
_write_boulder() {
	local plan_path="$1"
	write_state "boulder.json" "{\"active_plan\":\"${plan_path}\",\"status\":\"active\"}"
}

# Write a plan file with all checkboxes complete
_write_complete_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# My Plan

## TODOs

- [x] 1. First task
- [x] 2. Second task
- [x] 3. Third task
EOF
}

# Write a plan file with one incomplete checkbox
_write_incomplete_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# My Plan

## TODOs

- [x] 1. First task
- [ ] 2. Second task not done
EOF
}

# Write a verification-evidence.json with specified F-types (all matching same SHA)
_write_evidence_with_ftypes() {
	local -a ftypes=("$@")
	local entries="[]"
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	for ftype in "${ftypes[@]}"; do
		entries=$(echo "${entries}" | jq \
			--arg t "${ftype}" \
			--arg ts "${ts}" \
			--arg sha "${PLAN_SHA}" \
			'. + [{"type":$t,"command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts}]')
	done
	write_state "verification-evidence.json" "{\"entries\":${entries}}"
}

# Write evidence with a specific SHA override for one entry (for SHA-mismatch test)
_write_evidence_sha_mismatch() {
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local entries
	entries=$(jq -n \
		--arg ts "${ts}" \
		--arg sha "${PLAN_SHA}" \
		'[
			{"type":"final_verification_f1","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f2","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f3","command":"oracle: APPROVE","exit_code":0,"output_snippet":"plan_sha256:cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe verdict:APPROVE","timestamp":$ts},
			{"type":"final_verification_f4","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts}
		]')
	write_state "verification-evidence.json" "{\"entries\":${entries}}"
}

# Write a pending-final-verify.json marker
_write_marker() {
	local plan_path="$1"
	local marked_at="${2:-${NOW}}"
	write_state "pending-final-verify.json" \
		"{\"plan_path\":\"${plan_path}\",\"plan_sha256\":\"${PLAN_SHA}\",\"marked_at\":${marked_at},\"session_id\":\"bats-test-session\"}"
}

# ---------------------------------------------------------------------------
# (a) No active boulder AND no pending-final-verify marker → exit 0
# ---------------------------------------------------------------------------

@test "final-verification-evidence: no active plan and no marker allows Stop (exit 0)" {
	# State dir is empty — no boulder.json, no marker, no evidence
	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (b) Active plan with incomplete checkboxes → exit 0 (not our concern)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: incomplete checkboxes pass through (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/incomplete-plan.md"
	_write_incomplete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (c) All checkboxes [x], all 4 F-types present with matching plan SHA → exit 0
# ---------------------------------------------------------------------------

@test "final-verification-evidence: all checkboxes done and all 4 F-types present (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	_write_evidence_with_ftypes \
		"final_verification_f1" \
		"final_verification_f2" \
		"final_verification_f3" \
		"final_verification_f4"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (d) All checkboxes [x], F3 missing → exit 2, stderr names missing F-types
# ---------------------------------------------------------------------------

@test "final-verification-evidence: missing F3 blocks Stop (exit 2) and names it" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	_write_evidence_with_ftypes \
		"final_verification_f1" \
		"final_verification_f2" \
		"final_verification_f4"

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "final_verification_f3"
}

# ---------------------------------------------------------------------------
# (e) stop_hook_active=true → exit 0 (recursion guard)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: stop_hook_active guard exits 0" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# No evidence written — would normally block, but guard fires first

	run_hook "final-verification-evidence.sh" '{"stop_hook_active":true}'
	assert_success
}

# ---------------------------------------------------------------------------
# (f) No active boulder but fresh pending-final-verify marker + F-types missing → exit 2
# ---------------------------------------------------------------------------

@test "final-verification-evidence: marker present without evidence blocks Stop (exit 2)" {
	local plan_file="${BATS_TEST_TMPDIR}/marker-plan.md"
	_write_complete_plan "${plan_file}"
	# No boulder.json — simulates /stop-continuation clearing it
	_write_marker "${plan_file}"
	# No evidence written

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# (g) All 4 F-types present but plan_sha256 mismatch across entries → exit 2
# ---------------------------------------------------------------------------

@test "final-verification-evidence: SHA mismatch across F-type entries blocks Stop (exit 2)" {
	local plan_file="${BATS_TEST_TMPDIR}/sha-mismatch-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	_write_evidence_sha_mismatch

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "sha"
}

# ---------------------------------------------------------------------------
# (h) Background-subagent guard: active running agent → skip F1-F4, return {}
# ---------------------------------------------------------------------------

@test "final-verification: background-subagent guard skips F1-F4 enforcement" {
	local plan_file="${BATS_TEST_TMPDIR}/bg-agent-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# No evidence written — would normally block with exit 2 once all tasks done

	# Write subagents.json with one running agent (started_epoch within last 900s)
	local now
	now=$(date +%s)
	write_state "subagents.json" \
		"{\"active\":[{\"status\":\"running\",\"started_epoch\":${now},\"name\":\"fake-agent\"}]}"

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 0 ]
	[ "$output" = "{}" ]
}
