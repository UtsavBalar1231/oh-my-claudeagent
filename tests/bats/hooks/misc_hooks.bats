#!/usr/bin/env bats
# Behavioral tests for miscellaneous hook scripts

load '../test_helper'

# ---------------------------------------------------------------------------
# a. write-guard: overwrite warning for existing file
# ---------------------------------------------------------------------------

@test "write-guard: warns when target file already exists" {
	local target="$CLAUDE_PROJECT_ROOT/existing-file.txt"
	printf 'content' > "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "WRITE GUARD"
}

# ---------------------------------------------------------------------------
# b. write-guard: no warning for non-existent file
# ---------------------------------------------------------------------------

@test "write-guard: no warning when target file does not exist" {
	local target="$CLAUDE_PROJECT_ROOT/new-file-does-not-exist.txt"
	# Ensure the file does not exist
	rm -f "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# c. write-guard: evidence intercept for verification-evidence.json
# ---------------------------------------------------------------------------

@test "write-guard: intercepts writes targeting verification-evidence.json" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/state/verification-evidence.json"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "EVIDENCE"
}

# ---------------------------------------------------------------------------
# d. comment-checker: warns on TODO: implement
# ---------------------------------------------------------------------------

@test "comment-checker: warns when content contains 'TODO: implement'" {
	local content="function foo() {\n  // TODO: implement this\n  return null;\n}"
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "TODO"
}

# ---------------------------------------------------------------------------
# e. track-subagent-spawn: creates/updates subagents.json
# ---------------------------------------------------------------------------

@test "track-subagent-spawn: creates subagents.json with active entry" {
	local payload
	payload='{"tool_name":"Task","tool_input":{"subagent_type":"oh-my-claudeagent:explore","prompt":"Find patterns","model":"sonnet"}}'

	run_hook "track-subagent-spawn.sh" "$payload"
	assert_success

	local subagents_file="$CLAUDE_PROJECT_ROOT/.omca/state/subagents.json"
	assert [ -f "$subagents_file" ]

	local active_count
	active_count=$(jq '.active | length' "$subagents_file")
	[ "$active_count" -ge 1 ]
}

# ---------------------------------------------------------------------------
# f. subagent-complete: marks agent as completed in subagents.json
# ---------------------------------------------------------------------------

@test "subagent-complete: moves active agent to completed list" {
	# Pre-populate subagents.json with an active agent
	write_state "subagents.json" \
		'{"active":[{"id":"agent-test-abc","type":"explore","model":"sonnet","status":"running"}],"completed":[]}'

	local payload
	payload='{"hook_event_name":"SubagentStop","agent_id":"agent-test-abc","agent_type":"explore","last_assistant_message":"Done."}'

	run_hook "subagent-complete.sh" "$payload"
	assert_success

	local subagents_file="$CLAUDE_PROJECT_ROOT/.omca/state/subagents.json"
	local active_count
	active_count=$(jq '.active | length' "$subagents_file")
	local completed_count
	completed_count=$(jq '.completed | length' "$subagents_file")

	[ "$active_count" -eq 0 ]
	[ "$completed_count" -ge 1 ]
}

# ---------------------------------------------------------------------------
# g. empty-task-response: warns on empty/very short agent output
# ---------------------------------------------------------------------------

@test "empty-task-response: warns when agent output is empty" {
	local payload
	payload='{"tool_name":"Task","tool_input":{"subagent_type":"explore"},"tool_response":""}'

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "POOR AGENT OUTPUT"
}

@test "empty-task-response: warns when agent output is very short" {
	local payload
	payload='{"tool_name":"Task","tool_input":{"subagent_type":"explore"},"tool_response":"ok"}'

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "POOR AGENT OUTPUT"
}

# ---------------------------------------------------------------------------
# h. agent-usage-reminder: nudges on 3rd tool call without delegation
# ---------------------------------------------------------------------------

@test "agent-usage-reminder: emits delegation nudge on 3rd call without agent use" {
	# Pre-set toolCallCount to 2 so next call hits count=3 (% 3 == 0)
	write_state "agent-usage.json" '{"agentUsed":false,"toolCallCount":2}'

	local payload
	payload='{"tool_name":"Grep","tool_input":{"pattern":"foo"}}'

	run_hook "agent-usage-reminder.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "DELEGATION REMINDER"
}

@test "agent-usage-reminder: no nudge when agentUsed is true" {
	write_state "agent-usage.json" '{"agentUsed":true,"toolCallCount":5}'

	local payload
	payload='{"tool_name":"Grep","tool_input":{"pattern":"foo"}}'

	run_hook "agent-usage-reminder.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# i. track-question: creates pending-question.json
# ---------------------------------------------------------------------------

@test "track-question: creates pending-question.json on AskUserQuestion" {
	local payload
	payload='{"tool_name":"AskUserQuestion","tool_input":{"question":"What should I do?"}}'

	run_hook "track-question.sh" "$payload"
	assert_success

	local pending_file="$CLAUDE_PROJECT_ROOT/.omca/state/pending-question.json"
	assert [ -f "$pending_file" ]

	local pending
	pending=$(jq -r '.pending' "$pending_file")
	[ "$pending" = "true" ]
}

# ---------------------------------------------------------------------------
# j. teammate-idle-guard: blocks with exit 2 when ralph-state is active
# ---------------------------------------------------------------------------

@test "teammate-idle-guard: exits 2 (blocks) when ralph-state is active" {
	write_state "ralph-state.json" '{"status":"active","tasks":[]}'

	local payload='{"hook_event_name":"TeammateIdle","reason":"idle_prompt"}'

	run_hook "teammate-idle-guard.sh" "$payload"
	assert_failure
	[ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# k. teammate-idle-guard: allows idle (exit 0) when no mode state files exist
# ---------------------------------------------------------------------------

@test "teammate-idle-guard: exits 0 (allows idle) when no mode files present" {
	# Ensure no ralph or ultrawork state
	rm -f "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json"
	rm -f "$CLAUDE_PROJECT_ROOT/.omca/state/ultrawork-state.json"

	local payload='{"hook_event_name":"TeammateIdle","reason":"idle_prompt"}'

	run_hook "teammate-idle-guard.sh" "$payload"
	assert_success
}
