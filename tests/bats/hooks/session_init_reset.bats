#!/usr/bin/env bats
# session-init.sh: new-state-file session reset + shape-agnostic error-counts
# migration. Behavioral coverage for the Phase-4 wiring: plan-continuation.json,
# tool-loop-window.json, delegation-counter.json must not survive a SessionStart,
# and the legacy Task:delegate_error migration must merge correctly regardless
# of whether either side is bare-int or object-shaped.

load '../test_helper'

@test "session-init: deletes plan-continuation.json, tool-loop-window.json, delegation-counter.json on SessionStart" {
	write_state "plan-continuation.json" '{"consecutive_blocks": 3, "last_block_at": 100, "last_unchecked_count": 2, "same_count_run": 1, "stagnated": false}'
	write_state "tool-loop-window.json" '{"signature": "abc123", "count": 2}'
	write_state "delegation-counter.json" '{"direct_calls": 2, "silenced": false}'

	run_hook "session-init.sh" "{}"
	assert_success

	[ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/plan-continuation.json" ]
	[ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/tool-loop-window.json" ]
	[ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/delegation-counter.json" ]
}

@test "session-init: SessionStart with none of the three files present is a no-op (no error)" {
	run_hook "session-init.sh" "{}"
	assert_success
}

@test "session-init: error-counts migration merges bare-int legacy into bare-int target" {
	write_state "error-counts.json" '{"Task:delegate_error": 2, "Agent:delegate_error": 1}'

	run_hook "session-init.sh" "{}"
	assert_success

	local result
	result=$(read_state "error-counts.json")
	[[ "$(jq -r 'has("Task:delegate_error")' <<< "$result")" == "false" ]]
	[[ "$(jq -r '."Agent:delegate_error"' <<< "$result")" == "3" ]]
}

@test "session-init: error-counts migration merges bare-int legacy into object-shaped target" {
	write_state "error-counts.json" '{"Task:delegate_error": 2, "Agent:delegate_error": {"count": 1, "last_failure_at": 500, "last_errors": ["boom"]}}'

	run_hook "session-init.sh" "{}"
	assert_success

	local result
	result=$(read_state "error-counts.json")
	[[ "$(jq -r 'has("Task:delegate_error")' <<< "$result")" == "false" ]]
	[[ "$(jq -r '."Agent:delegate_error".count' <<< "$result")" == "3" ]]
	[[ "$(jq -r '."Agent:delegate_error".last_failure_at' <<< "$result")" == "500" ]]
	[[ "$(jq -r '."Agent:delegate_error".last_errors | length' <<< "$result")" == "1" ]]
}

@test "session-init: error-counts migration merges object-shaped legacy into bare-int target" {
	write_state "error-counts.json" '{"Task:delegate_error": {"count": 4, "last_failure_at": 700, "last_errors": ["oops"]}, "Agent:delegate_error": 1}'

	run_hook "session-init.sh" "{}"
	assert_success

	local result
	result=$(read_state "error-counts.json")
	[[ "$(jq -r 'has("Task:delegate_error")' <<< "$result")" == "false" ]]
	[[ "$(jq -r '."Agent:delegate_error".count' <<< "$result")" == "5" ]]
	[[ "$(jq -r '."Agent:delegate_error".last_failure_at' <<< "$result")" == "700" ]]
}

@test "session-init: error-counts migration is idempotent when Task:delegate_error is absent" {
	write_state "error-counts.json" '{"Agent:delegate_error": 3}'

	run_hook "session-init.sh" "{}"
	assert_success

	local result
	result=$(read_state "error-counts.json")
	[[ "$(jq -r '."Agent:delegate_error"' <<< "$result")" == "3" ]]
}
