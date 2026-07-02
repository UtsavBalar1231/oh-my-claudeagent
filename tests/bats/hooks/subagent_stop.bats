#!/usr/bin/env bats
load '../test_helper'

# subagent-stop.sh — removes the finished subagent's entry from
# subagent-models.json so the statusline active-agent count stays live.

STOP_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStop","agent_id":"agent-abc123","agent_type":"oh-my-claudeagent:executor"}'

@test "subagent-stop: removes the stopped agent entry" {
	write_state "subagent-models.json" \
		'{"agent-abc123":{"agent_type":"oh-my-claudeagent:executor","model":"Sonnet 5"},"agent-other":{"agent_type":"oh-my-claudeagent:explore","model":"Sonnet 5"}}'

	run_hook "subagent-stop.sh" "$STOP_PAYLOAD"
	assert_success

	local remaining
	remaining=$(read_state "subagent-models.json")
	run jq -e 'has("agent-abc123") | not' <<<"$remaining"
	assert_success
	run jq -e 'has("agent-other")' <<<"$remaining"
	assert_success
}

@test "subagent-stop: unknown agent_id leaves file unchanged" {
	write_state "subagent-models.json" \
		'{"agent-other":{"agent_type":"oh-my-claudeagent:explore","model":"Sonnet 5"}}'

	run_hook "subagent-stop.sh" '{"session_id":"test","hook_event_name":"SubagentStop","agent_id":"agent-ghost","agent_type":"oh-my-claudeagent:executor"}'
	assert_success

	local remaining
	remaining=$(read_state "subagent-models.json")
	run jq -e 'has("agent-other")' <<<"$remaining"
	assert_success
}

@test "subagent-stop: empty agent_id is a no-op" {
	write_state "subagent-models.json" '{"agent-other":{"agent_type":"x","model":""}}'

	run_hook "subagent-stop.sh" '{"session_id":"test","hook_event_name":"SubagentStop"}'
	assert_success

	local remaining
	remaining=$(read_state "subagent-models.json")
	run jq -e 'has("agent-other")' <<<"$remaining"
	assert_success
}

@test "subagent-stop: missing state file exits zero" {
	run_hook "subagent-stop.sh" "$STOP_PAYLOAD"
	assert_success
	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/subagent-models.json" ]
}
