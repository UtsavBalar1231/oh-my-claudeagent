#!/usr/bin/env bats
# Behavioral tests for plan-continuation-guard.sh — Stop hook that nudges the
# agent to keep working when the bound plan still has unchecked numbered
# tasks. Disjoint by construction with final-verification-evidence.sh (that
# gate only fires when the plan is fully checked); both read counts from the
# same count_plan_checkboxes helper.

load '../test_helper'

_write_boulder() {
	local plan_path="$1"
	local session="${2:-${CLAUDE_SESSION_ID}}"
	local bound_at="${3:-$(date +%s)}"
	jq -n --arg plan "${plan_path}" --arg name "test-plan" --arg sid "${session}" --argjson bound_at "${bound_at}" \
		'{"plans":{($name):{"active_plan":$plan,"started_at":"2026-01-01T00:00:00Z","session_ids":[$sid],"agent":"sisyphus"}},"bindings":{($sid):{"plan_name":$name,"bound_at":$bound_at}}}' \
		> "${CLAUDE_PROJECT_ROOT}/.omca/state/boulder.json"
}

_write_unchecked_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# My Plan

- [x] 1. First task
- [ ] 2. Second task not done
EOF
}

_write_complete_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# My Plan

- [x] 1. First task
- [x] 2. Second task
EOF
}

_write_no_boxes_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# Context Document

This is a reference doc with no tasks.
EOF
}

_write_malformed_only_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# My Plan

- [ ] Task without a number
EOF
}

_continuation_state() {
	cat "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Core ladder
# ---------------------------------------------------------------------------

@test "plan-continuation-guard: unchecked plan blocks Stop (exit 2) with next-task text" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -q "Second task not done"
}

@test "plan-continuation-guard: fully-checked plan allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" '{}'
	assert_success
}

@test "plan-continuation-guard: no bound plan allows Stop (exit 0)" {
	run_hook "plan-continuation-guard.sh" '{}'
	assert_success
}

@test "plan-continuation-guard: stop_hook_active exits 0 and leaves counters file untouched" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" '{"stop_hook_active":true}'
	assert_success
	[ ! -f "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json" ]
}

@test "plan-continuation-guard: OMCA_DISABLED_HOOKS kill switch exits 0" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	export OMCA_DISABLED_HOOKS="plan-continuation-guard"
	run_hook "plan-continuation-guard.sh" '{}'
	assert_success
	unset OMCA_DISABLED_HOOKS
}

# ---------------------------------------------------------------------------
# Cooldown / hard cap / stagnation
# ---------------------------------------------------------------------------

@test "plan-continuation-guard: cooldown suppresses a second rapid invocation (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" '{}'
	[ "$status" -eq 2 ]

	run_hook "plan-continuation-guard.sh" '{}'
	assert_success
}

@test "plan-continuation-guard: stagnation escape frees the 4th identical-count invocation" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	for _ in 1 2 3; do
		# Force last_block_at into the past between calls so cooldown never
		# masks the stagnation logic under test.
		if [[ -f "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json" ]]; then
			jq '.last_block_at = 0' "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json" \
				> "${BATS_TEST_TMPDIR}/pc.json" && mv "${BATS_TEST_TMPDIR}/pc.json" "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json"
		fi
		run_hook "plan-continuation-guard.sh" '{}'
		[ "$status" -eq 2 ]
	done

	jq '.last_block_at = 0' "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json" \
		> "${BATS_TEST_TMPDIR}/pc.json" && mv "${BATS_TEST_TMPDIR}/pc.json" "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json"
	run_hook "plan-continuation-guard.sh" '{}'
	assert_success
	[ "$(jq -r '.stagnated' "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json")" = "true" ]
}

# ---------------------------------------------------------------------------
# User-pause rail
# ---------------------------------------------------------------------------

@test "plan-continuation-guard: user-pause intent in latest message allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" '{"messages":[{"role":"user","content":"lets pause here for now"}]}'
	assert_success
}

# ---------------------------------------------------------------------------
# Disjointness matrix: at most one of the three Stop gates blocks per state
# ---------------------------------------------------------------------------

_run_status() {
	local script="$1"
	local payload="$2"
	bash "${CLAUDE_PLUGIN_ROOT}/scripts/${script}" <<< "${payload}" > /dev/null 2>&1
	echo "$?"
}

@test "disjointness matrix: unchecked plan state" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local s1 s2 s3
	s1=$(_run_status "plan-continuation-guard.sh" '{}')
	s2=$(_run_status "final-verification-evidence.sh" '{}')
	s3=$(_run_status "drift-guard.sh" '{}')

	local blocks=0
	[ "$s1" -eq 2 ] && blocks=$((blocks + 1))
	[ "$s2" -eq 2 ] && blocks=$((blocks + 1))
	[ "$s3" -eq 2 ] && blocks=$((blocks + 1))
	[ "$blocks" -le 1 ]
	[ "$s1" -eq 2 ]
}

@test "disjointness matrix: fully-checked plan state" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local s1 s2 s3
	s1=$(_run_status "plan-continuation-guard.sh" '{}')
	s2=$(_run_status "final-verification-evidence.sh" '{}')
	s3=$(_run_status "drift-guard.sh" '{}')

	local blocks=0
	[ "$s1" -eq 2 ] && blocks=$((blocks + 1))
	[ "$s2" -eq 2 ] && blocks=$((blocks + 1))
	[ "$s3" -eq 2 ] && blocks=$((blocks + 1))
	[ "$blocks" -le 1 ]
	[ "$s2" -eq 2 ]
}

@test "disjointness matrix: no-checkboxes plan state" {
	local plan_file="${BATS_TEST_TMPDIR}/no-boxes-plan.md"
	_write_no_boxes_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local s1 s2 s3
	s1=$(_run_status "plan-continuation-guard.sh" '{}')
	s2=$(_run_status "final-verification-evidence.sh" '{}')
	s3=$(_run_status "drift-guard.sh" '{}')

	local blocks=0
	[ "$s1" -eq 2 ] && blocks=$((blocks + 1))
	[ "$s2" -eq 2 ] && blocks=$((blocks + 1))
	[ "$s3" -eq 2 ] && blocks=$((blocks + 1))
	[ "$blocks" -le 1 ]
	[ "$s1" -eq 0 ]
	[ "$s2" -eq 0 ]
}

@test "disjointness matrix: malformed-only (unnumbered) checkbox plan state" {
	local plan_file="${BATS_TEST_TMPDIR}/malformed-plan.md"
	_write_malformed_only_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local s1 s2 s3
	s1=$(_run_status "plan-continuation-guard.sh" '{}')
	s2=$(_run_status "final-verification-evidence.sh" '{}')
	s3=$(_run_status "drift-guard.sh" '{}')

	local blocks=0
	[ "$s1" -eq 2 ] && blocks=$((blocks + 1))
	[ "$s2" -eq 2 ] && blocks=$((blocks + 1))
	[ "$s3" -eq 2 ] && blocks=$((blocks + 1))
	[ "$blocks" -le 1 ]
	[ "$s1" -eq 0 ]
	[ "$s2" -eq 0 ]
}
