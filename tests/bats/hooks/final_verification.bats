#!/usr/bin/env bats
# Behavioral tests for final-verification-evidence.sh — C-8 cross-session staleness short-circuit.

load '../test_helper'

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

# Write a pending-final-verify.json marker with the current session id
_write_marker() {
	local plan_path="$1"
	local marked_at="${2:-${NOW}}"
	local session_id="${3:-bats-test-session}"
	write_state "pending-final-verify.json" \
		"{\"plan_path\":\"${plan_path}\",\"plan_sha256\":\"\",\"marked_at\":${marked_at},\"session_id\":\"${session_id}\"}"
}

# ---------------------------------------------------------------------------
# Case (a): stale boulder from prior session, no MARKER → noop_exit (exit 0)
# The C-8 short-circuit fires: ACTIVE_PLAN is set but MARKER_PLAN is empty.
# The hook must NOT demand F1-F4 evidence.
# ---------------------------------------------------------------------------

@test "final-verification C-8: stale boulder with no marker triggers noop_exit (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/stale-plan.md"
	_write_complete_plan "${plan_file}"

	# Boulder set from a prior session, but no pending-final-verify marker exists
	_write_boulder "${plan_file}"
	# Explicitly ensure no marker file exists
	rm -f "${CLAUDE_PROJECT_ROOT}/.omca/state/pending-final-verify.json"
	# No evidence written — would block if cross-session short-circuit did not fire

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
	[ "$output" = "{}" ]
}

# ---------------------------------------------------------------------------
# Case (b): current-session execution — boulder set, marker set with current
# session_id, all checkboxes done but zero F1-F4 evidence → demand fires (exit 2).
# Ensures the short-circuit does NOT fire when a valid marker is present.
# ---------------------------------------------------------------------------

@test "final-verification C-8: current-session with marker but missing evidence blocks Stop (exit 2)" {
	local plan_file="${BATS_TEST_TMPDIR}/current-plan.md"
	_write_complete_plan "${plan_file}"

	local plan_sha
	plan_sha=$(sha256sum "${plan_file}" | awk '{print $1}')

	# Both boulder and marker present for current session
	_write_boulder "${plan_file}"
	_write_marker "${plan_file}" "${NOW}" "bats-test-session"

	# No F1-F4 evidence → demand must fire
	export CLAUDE_SESSION_ID="bats-test-session"
	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "F1-F4 evidence missing"
}
