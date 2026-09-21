#!/usr/bin/env bats
# Behavioral tests for empty-task-response.sh
# The report reaches the hook on the SubagentHandback payload under auto mode, and on a
# completed non-handback Agent result otherwise. Launch acks and hand-back pointers are silent.

load '../test_helper'

FULL_EXECUTOR_REPORT="TASK: fix the bug
STATUS: complete
CHANGES: scripts/foo.sh, fixed field read
EVIDENCE: just test-hooks passed, 21 tests
NOTES: no blockers"

# ---------------------------------------------------------------------------
# Payloads that carry no report at all
# ---------------------------------------------------------------------------

@test "empty-task-response: async launch acknowledgement is silent" {
	local payload
	payload=$(jq -nc '{
		hook_event_name: "PostToolUse",
		tool_name: "Agent",
		tool_input: {subagent_type: "oh-my-claudeagent:executor", prompt: "do the thing"},
		tool_response: {isAsync: true, status: "async_launched", agentId: "a1", outputFile: "/tmp/a1.txt"}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	assert_output ""
}

@test "empty-task-response: completed Agent result pointing at a hand-back is silent" {
	local payload
	payload=$(jq -nc '{
		hook_event_name: "PostToolUse",
		tool_name: "Agent",
		tool_input: {subagent_type: "oh-my-claudeagent:executor"},
		tool_response: {
			status: "completed",
			handback: "send",
			content: [{type: "text", text: "This agent'"'"'s report was delivered to you as a message from \"a1\" (its SubagentHandback call). Read it there; it is not repeated here."}]
		}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# SubagentHandback: the payload that carries the report
# ---------------------------------------------------------------------------

@test "empty-task-response: short hand-back message fires the poor-output advice" {
	local payload
	payload=$(jq -nc '{
		hook_event_name: "PostToolUse",
		tool_name: "SubagentHandback",
		agent_id: "a1",
		agent_type: "oh-my-claudeagent:executor",
		tool_input: {message: "4"},
		tool_response: {success: true, message: "Report delivered to your caller."}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	echo "$ctx" | grep -qi "POOR AGENT OUTPUT"
	echo "$ctx" | grep -qi "delegation error carrying the agent's partial work"
	# A cutoff arrives on the failure path, so this advice must not read as a certainty.
	! echo "$ctx" | grep -qi "likely exhausted its turns"
}

@test "empty-task-response: transitional-only hand-back message fires the poor-output advice" {
	local payload
	payload=$(jq -nc '{
		hook_event_name: "PostToolUse",
		tool_name: "SubagentHandback",
		agent_id: "a1",
		agent_type: "oh-my-claudeagent:executor",
		tool_input: {message: "Now let me start working on this task for you."}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	get_context | grep -qi "POOR AGENT OUTPUT"
}

@test "empty-task-response: full hand-back report is silent" {
	local payload
	payload=$(jq -nc --arg r "$FULL_EXECUTOR_REPORT" '{
		hook_event_name: "PostToolUse",
		tool_name: "SubagentHandback",
		agent_id: "a1",
		agent_type: "oh-my-claudeagent:executor",
		tool_input: {message: $r}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	assert_output ""
}

@test "empty-task-response: hand-back report missing sections gets the section advisory" {
	local payload
	payload=$(jq -nc '{
		hook_event_name: "PostToolUse",
		tool_name: "SubagentHandback",
		agent_id: "a1",
		agent_type: "oh-my-claudeagent:executor",
		tool_input: {message: "I completed the task and made the changes. The implementation is done and working correctly as expected."}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	echo "$ctx" | grep -qi "ADVISORY"
	echo "$ctx" | grep -q "executor"
}

@test "empty-task-response: oracle hand-back with its own sections is silent" {
	local payload
	payload=$(jq -nc '{
		hook_event_name: "PostToolUse",
		tool_name: "SubagentHandback",
		agent_id: "a1",
		agent_type: "oh-my-claudeagent:oracle",
		tool_input: {message: "RECOMMENDATION: use strategy A\nALTERNATIVES: strategy B, C\nRISKS: low overhead"}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Prepended harness note
# ---------------------------------------------------------------------------

@test "empty-task-response: a bracketed harness note is not measured as the report" {
	local payload
	payload=$(jq -nc --arg r "$FULL_EXECUTOR_REPORT" '{
		hook_event_name: "PostToolUse",
		tool_name: "SubagentHandback",
		agent_id: "a1",
		agent_type: "oh-my-claudeagent:executor",
		tool_input: {message: ("[harness: subagent output matched instruction-shaped pattern(s): foo]\n" + $r)}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	assert_output ""
}

@test "empty-task-response: a bracketed harness note alone counts as no report" {
	local payload
	payload=$(jq -nc '{
		hook_event_name: "PostToolUse",
		tool_name: "SubagentHandback",
		agent_id: "a1",
		agent_type: "oh-my-claudeagent:executor",
		tool_input: {message: "[harness: subagent output matched instruction-shaped pattern(s): foo]"}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	get_context | grep -qi "POOR AGENT OUTPUT"
}

# ---------------------------------------------------------------------------
# Non-auto mode: a completed Agent result carries the report in content[].text
# ---------------------------------------------------------------------------

@test "empty-task-response: completed Agent result without hand-back is still checked" {
	local payload
	payload=$(jq -nc '{
		hook_event_name: "PostToolUse",
		tool_name: "Agent",
		tool_input: {subagent_type: "oh-my-claudeagent:executor"},
		tool_response: {
			status: "completed",
			content: [{type: "text", text: "I completed the task and made the changes. The implementation is done and working correctly as expected."}]
		}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	get_context | grep -qi "ADVISORY"
}

@test "empty-task-response: completed Agent result with a full report is silent" {
	local payload
	payload=$(jq -nc --arg r "$FULL_EXECUTOR_REPORT" '{
		hook_event_name: "PostToolUse",
		tool_name: "Agent",
		tool_input: {subagent_type: "oh-my-claudeagent:executor"},
		tool_response: {status: "completed", content: [{type: "text", text: $r}]}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	assert_output ""
}

@test "empty-task-response: completed Agent result with empty content fires the poor-output advice" {
	local payload
	payload=$(jq -nc '{
		hook_event_name: "PostToolUse",
		tool_name: "Agent",
		tool_input: {subagent_type: "oh-my-claudeagent:executor"},
		tool_response: {status: "completed", content: []}
	}')

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	get_context | grep -qi "POOR AGENT OUTPUT"
}
