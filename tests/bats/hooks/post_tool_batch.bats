#!/usr/bin/env bats
# Behavioral tests for post-tool-batch.sh — signal-a (same-file conflict) and
# signal-b (batch-consolidated delegation reminder).

load '../test_helper'

# ---------------------------------------------------------------------------
# Payload builders
# ---------------------------------------------------------------------------

# Batch with two Edits to the SAME file (conflict).
same_file_edit_batch() {
	printf '{"hook_event_name":"PostToolBatch","session_id":"fixture-sid-001","tool_calls":[{"tool_name":"Edit","tool_input":{"file_path":"/project/src/foo.ts","old_string":"a","new_string":"b"},"tool_use_id":"toolu_001","tool_response":""},{"tool_name":"Edit","tool_input":{"file_path":"/project/src/foo.ts","old_string":"c","new_string":"d"},"tool_use_id":"toolu_002","tool_response":""}]}'
}

# Batch with Edits to two DIFFERENT files (no conflict).
disjoint_edit_batch() {
	printf '{"hook_event_name":"PostToolBatch","session_id":"fixture-sid-001","tool_calls":[{"tool_name":"Edit","tool_input":{"file_path":"/project/src/foo.ts","old_string":"a","new_string":"b"},"tool_use_id":"toolu_003","tool_response":""},{"tool_name":"Edit","tool_input":{"file_path":"/project/src/bar.ts","old_string":"c","new_string":"d"},"tool_use_id":"toolu_004","tool_response":""}]}'
}

# Batch with a Grep + Read (signal-b eligible, count triggers at 3).
grep_and_read_batch() {
	printf '{"hook_event_name":"PostToolBatch","session_id":"fixture-sid-001","tool_calls":[{"tool_name":"Read","tool_input":{"file_path":"/project/src/main.ts"},"tool_use_id":"toolu_005","tool_response":""},{"tool_name":"Grep","tool_input":{"pattern":"fn","path":"/project"},"tool_use_id":"toolu_006","tool_response":""}]}'
}

# Read-only batch (no signals).
read_only_batch() {
	printf '{"hook_event_name":"PostToolBatch","session_id":"fixture-sid-001","tool_calls":[{"tool_name":"Read","tool_input":{"file_path":"/project/src/main.ts"},"tool_use_id":"toolu_007","tool_response":""}]}'
}

# Subagent session with a Grep (agent_id present).
subagent_grep_batch() {
	printf '{"hook_event_name":"PostToolBatch","session_id":"fixture-sid-001","agent_id":"agent-exec-001","agent_type":"oh-my-claudeagent:executor","tool_calls":[{"tool_name":"Grep","tool_input":{"pattern":"fn","path":"/project"},"tool_use_id":"toolu_008","tool_response":""}]}'
}

# Subagent session with a same-file edit conflict (conflict warning still fires).
subagent_conflict_batch() {
	printf '{"hook_event_name":"PostToolBatch","session_id":"fixture-sid-001","agent_id":"agent-exec-001","agent_type":"oh-my-claudeagent:executor","tool_calls":[{"tool_name":"Write","tool_input":{"file_path":"/project/src/out.ts","content":"x"},"tool_use_id":"toolu_009","tool_response":""},{"tool_name":"Edit","tool_input":{"file_path":"/project/src/out.ts","old_string":"x","new_string":"y"},"tool_use_id":"toolu_010","tool_response":""}]}'
}

# Single-call Grep batch (no conflict possible, but signal-b applies).
single_grep_batch() {
	printf '{"hook_event_name":"PostToolBatch","session_id":"fixture-sid-001","tool_calls":[{"tool_name":"Grep","tool_input":{"pattern":"todo","path":"/project"},"tool_use_id":"toolu_011","tool_response":""}]}'
}

# Empty tool_calls (no-op).
empty_batch() {
	printf '{"hook_event_name":"PostToolBatch","session_id":"fixture-sid-001","tool_calls":[]}'
}

# Helper: seed agent-usage.json so reminder fires on next batch.
# toolCallCount=2 → increments to 3 → 3%3==0 → fires.
setup_usage_triggering() {
	write_state "agent-usage.json" '{"agentUsed": false, "toolCallCount": 2}'
	write_state "active-agents.json" '[]'
	write_state "subagents.json" '{"active": [], "completed": []}'
}

# ---------------------------------------------------------------------------
# Signal-a: same-file concurrent-edit warning
# ---------------------------------------------------------------------------

@test "post-tool-batch signal-a: same-file edits → conflict warning names path" {
	run_hook "post-tool-batch.sh" "$(same_file_edit_batch)"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -q "CONCURRENT EDIT WARNING"
	echo "$ctx" | grep -q "/project/src/foo.ts"
}

@test "post-tool-batch signal-a: disjoint-file edits → silent" {
	run_hook "post-tool-batch.sh" "$(disjoint_edit_batch)"
	assert_success
	assert_output ""
}

@test "post-tool-batch signal-a: subagent same-file conflict → warning still fires" {
	run_hook "post-tool-batch.sh" "$(subagent_conflict_batch)"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -q "CONCURRENT EDIT WARNING"
	echo "$ctx" | grep -q "/project/src/out.ts"
}

# ---------------------------------------------------------------------------
# Signal-b: batch-consolidated delegation reminder
# ---------------------------------------------------------------------------

@test "post-tool-batch signal-b: mixed Read+Grep → increments once, fires at 3" {
	setup_usage_triggering

	run_hook "post-tool-batch.sh" "$(grep_and_read_batch)"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "DELEGATION REMINDER"
}

@test "post-tool-batch signal-b: read-only batch → no increment" {
	setup_usage_triggering

	run_hook "post-tool-batch.sh" "$(read_only_batch)"
	assert_success
	assert_output ""
}

@test "post-tool-batch signal-b: subagent grep → no count, no reminder" {
	setup_usage_triggering

	run_hook "post-tool-batch.sh" "$(subagent_grep_batch)"
	assert_success
	assert_output ""
}

@test "post-tool-batch signal-b: single-call grep batch fires at cadence" {
	setup_usage_triggering

	run_hook "post-tool-batch.sh" "$(single_grep_batch)"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "DELEGATION REMINDER"
}

@test "post-tool-batch signal-b: empty tool_calls → exit 0, no output" {
	setup_usage_triggering

	run_hook "post-tool-batch.sh" "$(empty_batch)"
	assert_success
	assert_output ""
}

@test "post-tool-batch signal-b: agentUsed=true → no reminder even with Grep" {
	write_state "agent-usage.json" '{"agentUsed": true, "toolCallCount": 3}'
	write_state "active-agents.json" '[]'
	write_state "subagents.json" '{"active": [], "completed": []}'

	run_hook "post-tool-batch.sh" "$(single_grep_batch)"
	assert_success
	assert_output ""
}

@test "post-tool-batch: empty stdin → exit 0" {
	run bash "$CLAUDE_PLUGIN_ROOT/scripts/post-tool-batch.sh" <<< '{}'
	assert_success
}
