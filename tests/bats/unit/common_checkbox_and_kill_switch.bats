#!/usr/bin/env bats
# Unit tests for count_plan_checkboxes and hook_is_disabled in scripts/lib/common.sh

load '../test_helper'

# Write a fixture plan with 2 numbered unchecked, 1 malformed unnumbered
# unchecked, and 1 numbered checked box.
_write_mixed_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# Mixed Plan

- [ ] 1. First task
- [ ] 2. Second task
- [ ] Task 3: malformed, no number-dot
- [x] 4. Fourth task
EOF
}

@test "count_plan_checkboxes: mixed fixture reports unchecked=2 checked=1 total=3 raw_unchecked=3" {
	local plan_file="${BATS_TEST_TMPDIR}/mixed-plan.md"
	_write_mixed_plan "${plan_file}"

	run bash -c "source '${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh' && count_plan_checkboxes '${plan_file}'"
	assert_success
	[ "$output" = "2 1 3 3" ]
}

@test "count_plan_checkboxes: fully numbered-checked plan reports unchecked=0" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	cat > "${plan_file}" <<'EOF'
- [x] 1. First task
- [x] 2. Second task
EOF

	run bash -c "source '${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh' && count_plan_checkboxes '${plan_file}'"
	assert_success
	[ "$output" = "0 2 2 0" ]
}

@test "count_plan_checkboxes: uppercase X counts as checked (matches Python m.lower()=='x')" {
	local plan_file="${BATS_TEST_TMPDIR}/upper-x-plan.md"
	printf -- '- [X] 1. First task\n' > "${plan_file}"

	run bash -c "source '${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh' && count_plan_checkboxes '${plan_file}'"
	assert_success
	[ "$output" = "0 1 1 0" ]
}

@test "count_plan_checkboxes: missing file reports all zeros" {
	run bash -c "source '${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh' && count_plan_checkboxes '/nonexistent/plan.md'"
	assert_success
	[ "$output" = "0 0 0 0" ]
}

@test "hook_is_disabled: matches a name in a comma-separated OMCA_DISABLED_HOOKS list" {
	run bash -c "source '${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh' && OMCA_DISABLED_HOOKS='final-verification-evidence,other-hook' hook_is_disabled 'final-verification-evidence'"
	assert_success
}

@test "hook_is_disabled: matches a name in a whitespace-separated OMCA_DISABLED_HOOKS list" {
	run bash -c "source '${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh' && OMCA_DISABLED_HOOKS='final-verification-evidence other-hook' hook_is_disabled 'final-verification-evidence'"
	assert_success
}

@test "hook_is_disabled: does not match a name absent from the list" {
	run bash -c "source '${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh' && OMCA_DISABLED_HOOKS='other-hook' hook_is_disabled 'final-verification-evidence'"
	assert_failure
}

@test "hook_is_disabled: unset OMCA_DISABLED_HOOKS returns 1" {
	run bash -c "source '${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh' && unset OMCA_DISABLED_HOOKS; hook_is_disabled 'final-verification-evidence'"
	assert_failure
}
