#!/usr/bin/env bats
# Behavioral tests for final-verification-evidence.sh — single-check completeness gate.
# The hook blocks Stop (decision: block) iff the active plan is fully checked AND no
# final_verification evidence entry (exit_code=0) exists AND stop_hook_active is false.
# A single logged entry of type "final_verification" opens the gate permanently.

load '../test_helper'

# Write a boulder.json registry with an explicit binding for this test's
# session: strict resolution requires one; it no longer falls back to
# flat-schema migration or sole-plan guessing.
_write_boulder() {
	local plan_path="$1"
	local session="${2:-${CLAUDE_SESSION_ID}}"
	jq -n --arg plan "${plan_path}" --arg name "test-plan" --arg sid "${session}" \
		'{"plans":{($name):{"active_plan":$plan,"started_at":"2026-01-01T00:00:00Z","session_ids":[$sid],"agent":"sisyphus"}},"bindings":{($sid):{"plan_name":$name,"bound_at":1}}}' \
		> "${CLAUDE_PROJECT_ROOT}/.omca/state/boulder.json"
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
# a specific plan_sha256.
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

# A Stop block is exit 0 with the decision on stdout.
_assert_blocked() {
	assert_success
	[ "$(jq -r '.decision' <<< "$output")" = "block" ]
	[ -n "$(jq -r '.reason // ""' <<< "$output")" ]
}

_assert_allowed() {
	assert_success
	refute_output --partial '"decision"'
}

# ---------------------------------------------------------------------------
# (a) No active boulder — nothing to enforce (exit 0)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: no active plan allows Stop (exit 0)" {
	# State dir empty — no boulder.json, no evidence
	run_hook "final-verification-evidence.sh" '{}'
	_assert_allowed
}

# ---------------------------------------------------------------------------
# (b) Active plan with incomplete checkboxes — plan not done, allow stop
# ---------------------------------------------------------------------------

@test "final-verification-evidence: incomplete checkboxes pass through (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/incomplete-plan.md"
	_write_incomplete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "final-verification-evidence.sh" '{}'
	_assert_allowed
}

# ---------------------------------------------------------------------------
# (c) All checkboxes done, no final_verification evidence — block Stop
# ---------------------------------------------------------------------------

@test "final-verification-evidence: complete plan with no evidence blocks Stop" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# No evidence written

	run_hook "final-verification-evidence.sh" '{}'
	_assert_blocked
	echo "$output" | grep -qi "final_verification"
}

@test "final-verification-evidence: registered complete plan bound to another session allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	# Complete plan is registered and bound, but only to a different session.
	# Strict resolution must not fall back to it for this test's session, even
	# though no evidence exists (which would otherwise block).
	_write_boulder "${plan_file}" "other-session"

	run_hook "final-verification-evidence.sh" '{}'
	_assert_allowed
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
	_assert_allowed
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
	_assert_allowed
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
	_assert_allowed
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
	_assert_allowed
}

# ---------------------------------------------------------------------------
# (h) final_verification evidence with exit_code=1 (INCOMPLETE) does not open gate
# ---------------------------------------------------------------------------

@test "final-verification-evidence: final_verification with exit_code=1 does not open gate" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	_write_final_verification_evidence 1

	run_hook "final-verification-evidence.sh" '{}'
	_assert_blocked
}

# ---------------------------------------------------------------------------
# (i) boulder.json present but active_plan file missing — allow stop (no plan to enforce)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: boulder with missing plan file allows Stop (exit 0)" {
	write_state "boulder.json" '{"active_plan":"/nonexistent/plan.md"}'

	run_hook "final-verification-evidence.sh" '{}'
	_assert_allowed
}

# ---------------------------------------------------------------------------
# (j) Corrupt evidence file — corruption guard fires (exit 2, explicit message)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: corrupt evidence file triggers corruption guard" {
	local plan_file="${BATS_TEST_TMPDIR}/corrupt-evidence-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "THIS IS NOT JSON {" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"

	run_hook "final-verification-evidence.sh" '{}'
	_assert_blocked
	echo "$output" | grep -qi "corrupt"
}

# ---------------------------------------------------------------------------
# (k) Other evidence types present but no final_verification — gate still blocks
# ---------------------------------------------------------------------------

@test "final-verification-evidence: non-final evidence types do not open gate" {
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
	_assert_blocked
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
	_assert_allowed
}

# ---------------------------------------------------------------------------
# (m) plan_sha256 scoping: non-matching entry does not open the gate
# ---------------------------------------------------------------------------

@test "final-verification-evidence: mismatched plan_sha256 entry blocks Stop" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	_write_final_verification_evidence_scoped "0000000000000000000000000000000000000000000000000000000000000000" 0

	run_hook "final-verification-evidence.sh" '{}'
	_assert_blocked
}

# ---------------------------------------------------------------------------
# (n) unbound session (no boulder.json at all — empty shim result) allows Stop
# ---------------------------------------------------------------------------

@test "final-verification-evidence: unbound session (empty shim result) allows Stop (exit 0)" {
	# No boulder.json written at all — the shim resolves to {} for this session.
	run_hook "final-verification-evidence.sh" '{}'
	_assert_allowed
}

@test "final-verification-evidence: unparseable boulder.json says the gate is off instead of going quiet" {
	printf 'NOT JSON {' > "${CLAUDE_PROJECT_ROOT}/.omca/state/boulder.json"

	run_hook "final-verification-evidence.sh" '{}'
	_assert_allowed
	assert_output --partial "not valid JSON"
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
	_assert_allowed
	assert_output --partial "stdin read timed out"
}

# ---------------------------------------------------------------------------
# (p) Malformed/unnumbered unchecked box does not count toward completion:
# counting now goes through count_plan_checkboxes, agreeing with boulder_progress
# ---------------------------------------------------------------------------

@test "final-verification-evidence: numbered-complete plan with a malformed unnumbered box still allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/malformed-plan.md"
	cat > "${plan_file}" <<'EOF'
# My Plan

- [x] 1. First task
- [x] 2. Second task
- [ ] Task 3: malformed, no number-dot
EOF
	_write_boulder "${plan_file}"
	_write_final_verification_evidence 0

	run_hook "final-verification-evidence.sh" '{}'
	_assert_allowed
}

# ---------------------------------------------------------------------------
# (q) OMCA_DISABLED_HOOKS kill switch
# ---------------------------------------------------------------------------

@test "final-verification-evidence: OMCA_DISABLED_HOOKS listing this hook bypasses the gate (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# No evidence: would block, but the kill switch fires first.

	export OMCA_DISABLED_HOOKS="final-verification-evidence"
	run_hook "final-verification-evidence.sh" '{}'
	_assert_allowed
	unset OMCA_DISABLED_HOOKS
}

@test "final-verification-evidence: OMCA_DISABLED_HOOKS listing a different hook does not bypass the gate" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# No evidence: the gate should still block.

	export OMCA_DISABLED_HOOKS="other-hook"
	run_hook "final-verification-evidence.sh" '{}'
	_assert_blocked
	unset OMCA_DISABLED_HOOKS
}

@test "final-verification-evidence: legacy OMCA_HOOK_DISABLE_FINAL_VERIFY=1 still disables alongside OMCA_DISABLED_HOOKS" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# No evidence: would block, but the legacy kill switch fires first.

	export OMCA_HOOK_DISABLE_FINAL_VERIFY=1
	run_hook "final-verification-evidence.sh" '{}'
	_assert_allowed
	unset OMCA_HOOK_DISABLE_FINAL_VERIFY
}

# ---------------------------------------------------------------------------
# Shared block_exit helper: stdout is the only block signal, so a jq failure
# must not degrade a block into an allow.
# ---------------------------------------------------------------------------

@test "block_exit: falls back to a static block payload when jq cannot encode the reason" {
	run env HOOK_INPUT='{}' bash -c '
		source "'"${CLAUDE_PLUGIN_ROOT}"'/scripts/lib/common.sh"
		jq() { return 1; }
		block_exit "reason that cannot be encoded"
	'
	assert_success
	[ "$(jq -r '.decision' <<< "$output")" = "block" ]
	[ -n "$(jq -r '.reason // ""' <<< "$output")" ]
}

@test "block_exit: emits only the blocking pair, no additionalContext duplicate" {
	run env HOOK_INPUT='{}' bash -c '
		source "'"${CLAUDE_PLUGIN_ROOT}"'/scripts/lib/common.sh"
		block_exit "plain reason"
	'
	assert_success
	[ "$(jq -r '.reason' <<< "$output")" = "plain reason" ]
	[ "$(jq -r 'has("hookSpecificOutput")' <<< "$output")" = "false" ]
}

# ---------------------------------------------------------------------------
# Loop bounding: no test in this suite drove the gate past HARD_CAP_BLOCKS
# before, so a cap of 5 was never exercised and an unresolved state blocked
# every Stop for the rest of the session.
# ---------------------------------------------------------------------------

@test "final-verification-evidence: a missing verdict stops blocking once the Stop-block cap is hit" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local decisions="" i
	# 7 > HARD_CAP_BLOCKS (5).
	for i in 1 2 3 4 5 6 7; do
		run_hook "final-verification-evidence.sh" '{}'
		decisions+="$(jq -r '.decision // "allow"' <<< "$output") "
	done

	assert_equal "$decisions" "block block block block block allow allow "
}

@test "final-verification-evidence: a corrupt evidence file stops blocking once the cap is hit" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "THIS IS NOT JSON {" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"

	local decisions="" i
	for i in 1 2 3 4 5 6 7; do
		run_hook "final-verification-evidence.sh" '{}'
		decisions+="$(jq -r '.decision // "allow"' <<< "$output") "
	done

	assert_equal "$decisions" "block block block block block allow allow "
}

@test "final-verification-evidence: logging the verdict restores the Stop-block budget" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local i
	for i in 1 2 3; do
		run_hook "final-verification-evidence.sh" '{}'
		_assert_blocked
	done

	_write_final_verification_evidence 0
	run_hook "final-verification-evidence.sh" '{}'
	assert_success
	assert_output '{}'
	[ ! -f "${CLAUDE_PROJECT_ROOT}/.omca/state/stop-blocks.json" ]
}

@test "final-verification-evidence: jq unavailable allows Stop" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local dir="${BATS_TEST_TMPDIR}/nojq-bin"
	mkdir -p "${dir}"
	local c p
	for c in bash cat date grep sed cut tr basename dirname mktemp mv rm mkdir \
		flock printf sha256sum tail head sort wc awk tac stat chmod python3; do
		p=$(command -v "$c" 2>/dev/null) && ln -sf "$p" "${dir}/$c"
	done

	run env -i PATH="${dir}" HOME="${HOME}" CLAUDE_PROJECT_ROOT="${CLAUDE_PROJECT_ROOT}" \
		CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID}" \
		HOOK_INPUT='{"stop_hook_active":false}' HOOK_INPUT_TIMED_OUT=0 \
		"${dir}/bash" "${CLAUDE_PLUGIN_ROOT}/scripts/final-verification-evidence.sh" < /dev/null
	assert_success
	refute_output --partial '"decision"'
}
