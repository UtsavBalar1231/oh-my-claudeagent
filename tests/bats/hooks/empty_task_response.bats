#!/usr/bin/env bats
# Behavioral tests for empty-task-response.sh
# Covers structured tool_response (Agent tool format), transitional-only text, and empty output.

load '../test_helper'

# ---------------------------------------------------------------------------
# Case 1: structured object response with RECOMMENDATION — advisory must NOT fire
# ---------------------------------------------------------------------------

@test "empty-task-response: no advisory when oracle returns structured result with RECOMMENDATION" {
	local payload
	payload=$(jq -nc '{
		tool_name: "Task",
		tool_input: {subagent_type: "oh-my-claudeagent:oracle"},
		tool_response: {result: "RECOMMENDATION: use strategy A\nALTERNATIVES: strategy B, C\nRISKS: low overhead"}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	# No advisory context should be emitted
	if [[ -n "$ctx" ]]; then
		echo "$ctx" | grep -qiv "POOR AGENT OUTPUT" || true
		echo "$ctx" | grep -qiv "ADVISORY" || true
		# Fail explicitly if advisory fired
		echo "Unexpected advisory context: $ctx" >&2
		false
	fi
}

# ---------------------------------------------------------------------------
# Case 2: structured object response with transitional-only text — advisory FIRES
# ---------------------------------------------------------------------------

@test "empty-task-response: advisory fires when executor returns transitional-only structured result" {
	local payload
	payload=$(jq -nc '{
		tool_name: "Task",
		tool_input: {subagent_type: "oh-my-claudeagent:executor"},
		tool_response: {result: "Now let me start working on this task for you."}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "POOR AGENT OUTPUT"
}

# ---------------------------------------------------------------------------
# Case 3: structured object response with empty result — advisory FIRES
# ---------------------------------------------------------------------------

@test "empty-task-response: advisory fires when tool_response has empty result field" {
	local payload
	payload=$(jq -nc '{
		tool_name: "Task",
		tool_input: {subagent_type: "oh-my-claudeagent:executor"},
		tool_response: {result: ""}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "POOR AGENT OUTPUT"
}

# ---------------------------------------------------------------------------
# Case 4: missing sections advisory fires for executor with good-length but incomplete output
# ---------------------------------------------------------------------------

@test "empty-task-response: advisory fires for executor missing required sections" {
	local response
	response="I completed the task and made the changes. The implementation is done and working correctly as expected."

	local payload
	payload=$(jq -nc --arg r "$response" '{
		tool_name: "Task",
		tool_input: {subagent_type: "oh-my-claudeagent:executor"},
		tool_response: {result: $r}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "ADVISORY"
}

# ---------------------------------------------------------------------------
# Case 5: executor with all required sections — no advisory
# ---------------------------------------------------------------------------

@test "empty-task-response: no advisory when executor returns all required sections" {
	local response
	response="TASK: fix the bug
STATUS: complete
CHANGES: scripts/foo.sh — fixed field read
EVIDENCE: just test-hooks passed, 21 tests
NOTES: no blockers"

	local payload
	payload=$(jq -nc --arg r "$response" '{
		tool_name: "Task",
		tool_input: {subagent_type: "oh-my-claudeagent:executor"},
		tool_response: {result: $r}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	if [[ -n "$ctx" ]]; then
		# Should not contain POOR AGENT OUTPUT or ADVISORY
		if echo "$ctx" | grep -qi "POOR AGENT OUTPUT\|ADVISORY"; then
			echo "Unexpected advisory: $ctx" >&2
			false
		fi
	fi
}

# ---------------------------------------------------------------------------
# Case 6: plain string tool_response (backward compat) — empty string fires advisory
# ---------------------------------------------------------------------------

@test "empty-task-response: advisory fires for plain empty string tool_response" {
	local payload
	payload='{"tool_name":"Task","tool_input":{"subagent_type":"oh-my-claudeagent:explore"},"tool_response":""}'

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "POOR AGENT OUTPUT"
}
