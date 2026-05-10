#!/usr/bin/env bats
# Behavioral tests for pre-compact.sh — F1-F4 freshness gate (H-17).

load '../test_helper'

NOW=$(date +%s)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

_write_boulder() {
	local plan_path="$1"
	write_state "boulder.json" "{\"active_plan\":\"${plan_path}\"}"
}

_write_marker() {
	local plan_path="$1"
	local session_id="${2:-bats-test-session}"
	write_state "pending-final-verify.json" \
		"{\"plan_path\":\"${plan_path}\",\"plan_sha256\":\"\",\"marked_at\":${NOW},\"session_id\":\"${session_id}\"}"
}

_write_plan() {
	local plan_path="$1"
	printf '# Plan\n- [x] task one\n- [x] task two\n' > "${plan_path}"
}

# Write N fresh F1-F4 evidence entries for the given plan SHA.
_write_f_evidence() {
	local plan_sha="$1"
	local count="${2:-4}"
	local entries="[]"
	local ftypes=("final_verification_f1" "final_verification_f2" "final_verification_f3" "final_verification_f4")
	for (( i=0; i<count; i++ )); do
		local ftype="${ftypes[$i]}"
		entries=$(jq --arg t "${ftype}" --arg ts "${TS}" --arg sha "${plan_sha}" \
			'. + [{
				"type": $t,
				"command": "oracle: APPROVE",
				"exit_code": 0,
				"output_snippet": ("plan_sha256:" + $sha + " verdict:APPROVE"),
				"timestamp": $ts,
				"plan_sha256": $sha
			}]' <<< "${entries}")
	done
	write_state "verification-evidence.json" "{\"entries\":${entries}}"
}

# ─── Case (a): plan mid-flight + missing evidence → block ────────────────────

@test "pre-compact blocks when active plan + session marker + no F1-F4 evidence" {
	local plan_file="${BATS_TEST_TMPDIR}/active-plan.md"
	_write_plan "${plan_file}"
	_write_boulder "${plan_file}"
	_write_marker "${plan_file}" "bats-test-session"
	# No evidence file at all

	export CLAUDE_SESSION_ID="bats-test-session"
	run_hook "pre-compact.sh" '{"session_id":"bats-test-session","hook_event_name":"PreCompact","trigger":"auto"}'
	assert_success
	echo "${output}" | jq -e '.decision == "block"' >/dev/null
	echo "${output}" | jq -e '.reason | test("F1-F4")' >/dev/null
}

# ─── Case (b): plan mid-flight + complete F1-F4 evidence → permit ────────────

@test "pre-compact permits when active plan + session marker + all 4 F1-F4 entries fresh" {
	local plan_file="${BATS_TEST_TMPDIR}/active-plan.md"
	_write_plan "${plan_file}"
	local plan_sha
	plan_sha=$(sha256sum "${plan_file}" | awk '{print $1}')

	_write_boulder "${plan_file}"
	_write_marker "${plan_file}" "bats-test-session"
	_write_f_evidence "${plan_sha}" 4

	export CLAUDE_SESSION_ID="bats-test-session"
	run_hook "pre-compact.sh" '{"session_id":"bats-test-session","hook_event_name":"PreCompact","trigger":"auto"}'
	assert_success
	# Permit path writes context to disk (no block JSON on stdout)
	[[ "${output}" != *'"decision":"block"'* ]]
}

# ─── Case (c): no active plan → permit ───────────────────────────────────────

@test "pre-compact permits when no active plan in boulder" {
	# Boulder absent entirely
	export CLAUDE_SESSION_ID="bats-test-session"
	run_hook "pre-compact.sh" '{"session_id":"bats-test-session","hook_event_name":"PreCompact","trigger":"auto"}'
	assert_success
	[[ "${output}" != *'"decision":"block"'* ]]
}

# ─── Extra: mismatched session in marker → permit (cross-session permissive) ──

@test "pre-compact permits when marker session_id differs from current session" {
	local plan_file="${BATS_TEST_TMPDIR}/active-plan.md"
	_write_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# Marker written by a different session
	_write_marker "${plan_file}" "other-session-id"
	# No evidence

	export CLAUDE_SESSION_ID="bats-test-session"
	run_hook "pre-compact.sh" '{"session_id":"bats-test-session","hook_event_name":"PreCompact","trigger":"auto"}'
	assert_success
	[[ "${output}" != *'"decision":"block"'* ]]
}
