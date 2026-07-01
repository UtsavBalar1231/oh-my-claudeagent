#!/usr/bin/env bats
# Behavioral tests for final-verification-evidence.sh — single-check completeness gate.
# The hook blocks Stop (exit 2) iff the active plan is fully checked AND no
# final_verification evidence entry (exit_code=0) exists AND stop_hook_active is false.
# A single logged entry of type "final_verification" opens the gate permanently.

load '../test_helper'

# Write a synthetic boulder.json pointing to a plan file. Old flat schema with a
# plan_name so the resolver shim's in-memory migration + single-plan fallback
# binds this session to it (test_helper's CLAUDE_SESSION_ID has no explicit binding).
_write_boulder() {
	local plan_path="$1"
	write_state "boulder.json" "{\"active_plan\":\"${plan_path}\",\"plan_name\":\"test-plan\"}"
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

# Write a verification-evidence.json with a final_verification entry (legacy —
# no plan_sha256 field).
_write_final_verification_evidence() {
	local exit_code="${1:-0}"
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local entry
	entry=$(jq -n \
		--arg ts "${ts}" \
		--argjson ec "${exit_code}" \
		'{"type":"final_verification","command":"executor: COMPLETE","exit_code":$ec,"output_snippet":"COMPLETE","timestamp":$ts}')
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "{\"entries\":[${entry}]}" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"
}

# Write a verification-evidence.json with a final_verification entry scoped to
# a specific plan_sha256 (Task 5 evidence scoping).
_write_final_verification_evidence_scoped() {
	local plan_sha256="$1"
	local exit_code="${2:-0}"
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local entry
	entry=$(jq -n \
		--arg ts "${ts}" \
		--argjson ec "${exit_code}" \
		--arg sha "${plan_sha256}" \
		'{"type":"final_verification","command":"executor: COMPLETE","exit_code":$ec,"output_snippet":"COMPLETE","timestamp":$ts,"plan_sha256":$sha}')
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "{\"entries\":[${entry}]}" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"
}

# ---------------------------------------------------------------------------
# (a) No active boulder — nothing to enforce (exit 0)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: no active plan allows Stop (exit 0)" {
	# State dir empty — no boulder.json, no evidence
	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (b) Active plan with incomplete checkboxes — plan not done, allow stop
# ---------------------------------------------------------------------------

@test "final-verification-evidence: incomplete checkboxes pass through (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/incomplete-plan.md"
	_write_incomplete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (c) All checkboxes done, no final_verification evidence — block Stop
# ---------------------------------------------------------------------------

@test "final-verification-evidence: complete plan with no evidence blocks Stop (exit 2)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# No evidence written

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "final_verification"
}

# ---------------------------------------------------------------------------
# (d) All checkboxes done, final_verification evidence present — allow stop
# ---------------------------------------------------------------------------

@test "final-verification-evidence: complete plan with final_verification evidence allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	_write_final_verification_evidence 0

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (e) stop_hook_active=true — recursion guard fires before evidence check
# ---------------------------------------------------------------------------

@test "final-verification-evidence: stop_hook_active guard exits 0" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# No evidence — would block, but guard fires first

	run_hook "final-verification-evidence.sh" '{"stop_hook_active":true}'
	assert_success
}

# ---------------------------------------------------------------------------
# (f) Kill switch (OMCA_HOOK_DISABLE_FINAL_VERIFY=1) bypasses enforcement
# ---------------------------------------------------------------------------

@test "final-verification-evidence: kill switch bypasses gate (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# No evidence — would block, but kill switch fires first

	export OMCA_HOOK_DISABLE_FINAL_VERIFY=1
	run_hook "final-verification-evidence.sh" '{}'
	assert_success
	unset OMCA_HOOK_DISABLE_FINAL_VERIFY
}

# ---------------------------------------------------------------------------
# (g) Plan with no checkboxes at all (non-task plan) — allow stop
# ---------------------------------------------------------------------------

@test "final-verification-evidence: plan with no checkboxes allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/no-tasks-plan.md"
	cat > "${plan_file}" <<'EOF'
# Context Document

This is a reference doc with no tasks.
EOF
	_write_boulder "${plan_file}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (h) final_verification evidence with exit_code=1 (INCOMPLETE) does not open gate
# ---------------------------------------------------------------------------

@test "final-verification-evidence: final_verification with exit_code=1 does not open gate (exit 2)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	_write_final_verification_evidence 1

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# (i) boulder.json present but active_plan file missing — allow stop (no plan to enforce)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: boulder with missing plan file allows Stop (exit 0)" {
	write_state "boulder.json" '{"active_plan":"/nonexistent/plan.md"}'

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (j) Corrupt evidence file — corruption guard fires (exit 2, explicit message)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: corrupt evidence file triggers corruption guard (exit 2)" {
	local plan_file="${BATS_TEST_TMPDIR}/corrupt-evidence-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "THIS IS NOT JSON {" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "corrupt"
}

# ---------------------------------------------------------------------------
# (k) Other evidence types present but no final_verification — gate still blocks
# ---------------------------------------------------------------------------

@test "final-verification-evidence: non-final evidence types do not open gate (exit 2)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "{\"entries\":[
		{\"type\":\"build\",\"command\":\"just build\",\"exit_code\":0,\"output_snippet\":\"ok\",\"timestamp\":\"${ts}\"},
		{\"type\":\"test\",\"command\":\"just test\",\"exit_code\":0,\"output_snippet\":\"10 passed\",\"timestamp\":\"${ts}\"}
	]}" > "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# (l) plan_sha256 scoping: matching entry opens the gate
# ---------------------------------------------------------------------------

@test "final-verification-evidence: matching plan_sha256 entry allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	local sha
	sha=$(sha256sum "${plan_file}" | awk '{print $1}')
	_write_final_verification_evidence_scoped "${sha}" 0

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (m) plan_sha256 scoping: non-matching entry does not open the gate
# ---------------------------------------------------------------------------

@test "final-verification-evidence: mismatched plan_sha256 entry blocks Stop (exit 2)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	_write_final_verification_evidence_scoped "0000000000000000000000000000000000000000000000000000000000000000" 0

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# (n) unbound session (no boulder.json at all — empty shim result) allows Stop
# ---------------------------------------------------------------------------

@test "final-verification-evidence: unbound session (empty shim result) allows Stop (exit 0)" {
	# No boulder.json written at all — the shim resolves to {} for this session.
	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (o) stdin read timeout — warn, allow Stop rather than trap the session
# ---------------------------------------------------------------------------

@test "final-verification-evidence: stdin timeout warns and allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# No evidence — would normally block, but an unreadable stdin signal must
	# not trap the session on a check that cannot be evaluated.

	run env HOOK_INPUT="" HOOK_INPUT_TIMED_OUT=1 \
		CLAUDE_PROJECT_ROOT="${CLAUDE_PROJECT_ROOT}" CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID}" \
		bash "${CLAUDE_PLUGIN_ROOT}/scripts/final-verification-evidence.sh"
	assert_success
	assert_output --partial "stdin read timed out"
}
