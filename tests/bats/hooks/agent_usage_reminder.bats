#!/usr/bin/env bats
# Delegation-reminder tests for post-tool-batch.sh (signal-b).
# agent-usage-reminder.sh was absorbed into post-tool-batch.sh; tests live here.

load '../test_helper'

# Batch input helpers — all payloads use tool_calls[] (PostToolBatch schema).

# A batch with one Grep call (triggers signal-b).
grep_batch() {
	printf '{"hook_event_name":"PostToolBatch","session_id":"fixture-sid-001","tool_calls":[{"tool_name":"Grep","tool_input":{"pattern":"function","path":"/project/src"},"tool_use_id":"toolu_001","tool_response":""}]}'
}

# A batch with only Read calls (no signal-b, no signal-a).
read_batch() {
	printf '{"hook_event_name":"PostToolBatch","session_id":"fixture-sid-001","tool_calls":[{"tool_name":"Read","tool_input":{"file_path":"/project/src/main.ts"},"tool_use_id":"toolu_002","tool_response":""}]}'
}

# A subagent grep batch (agent_id present).
subagent_grep_batch() {
	printf '{"hook_event_name":"PostToolBatch","session_id":"fixture-sid-001","agent_id":"agent-exec-001","agent_type":"oh-my-claudeagent:executor","tool_calls":[{"tool_name":"Grep","tool_input":{"pattern":"fn","path":"/project"},"tool_use_id":"toolu_003","tool_response":""}]}'
}

# Helper: write agent-usage.json so the reminder fires after the +1 increment.
# The hook does toolCallCount += 1 then checks (count % 3 == 0).
# Starting at 2 → increments to 3 → 3 % 3 == 0 → reminder fires.
setup_usage_triggering() {
	write_state "agent-usage.json" '{"agentUsed": false, "toolCallCount": 2}'
}

# ---------------------------------------------------------------------------
# Case 1: same agent ID in both files → unioned count = 1, suppressed
# ---------------------------------------------------------------------------

@test "post-tool-batch delegation reminder: both files share same ID → suppressed" {
	setup_usage_triggering
	write_state "active-agents.json" '[{"id": "agent-abc", "agent": "explore"}]'
	write_state "subagents.json" '{"active": [{"id": "agent-abc", "type": "explore"}], "completed": []}'

	run_hook "post-tool-batch.sh" "$(grep_batch)"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Case 2: only subagents.json has the agent (SubagentStart hasn't fired yet)
# ---------------------------------------------------------------------------

@test "post-tool-batch delegation reminder: only subagents.json has agent → suppressed" {
	setup_usage_triggering
	write_state "active-agents.json" '[]'
	write_state "subagents.json" '{"active": [{"id": "spawn-001", "type": "explore"}], "completed": []}'

	run_hook "post-tool-batch.sh" "$(grep_batch)"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Case 3: only active-agents.json has the agent
# ---------------------------------------------------------------------------

@test "post-tool-batch delegation reminder: only active-agents.json has agent → suppressed" {
	setup_usage_triggering
	write_state "active-agents.json" '[{"id": "agent-xyz", "agent": "librarian"}]'
	write_state "subagents.json" '{"active": [], "completed": []}'

	run_hook "post-tool-batch.sh" "$(grep_batch)"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Case 4: both files empty → reminder fires (count 2→3, 3%3==0)
# ---------------------------------------------------------------------------

@test "post-tool-batch delegation reminder: both files empty → reminder fires" {
	setup_usage_triggering
	write_state "active-agents.json" '[]'
	write_state "subagents.json" '{"active": [], "completed": []}'

	run_hook "post-tool-batch.sh" "$(grep_batch)"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "DELEGATION REMINDER"
}

# ---------------------------------------------------------------------------
# Case 5: neither file exists → reminder fires
# ---------------------------------------------------------------------------

@test "post-tool-batch delegation reminder: state files absent → reminder fires" {
	setup_usage_triggering

	run_hook "post-tool-batch.sh" "$(grep_batch)"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "DELEGATION REMINDER"
}

# ---------------------------------------------------------------------------
# Case 6: agentUsed=true → exits before reminder regardless of count
# ---------------------------------------------------------------------------

@test "post-tool-batch delegation reminder: agentUsed=true → no reminder" {
	write_state "agent-usage.json" '{"agentUsed": true, "toolCallCount": 3}'
	write_state "active-agents.json" '[]'
	write_state "subagents.json" '{"active": [], "completed": []}'

	run_hook "post-tool-batch.sh" "$(grep_batch)"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Case 7: subagent session (agent_id present) → no count, no reminder
# ---------------------------------------------------------------------------

@test "post-tool-batch delegation reminder: subagent session → no count or reminder" {
	setup_usage_triggering
	write_state "active-agents.json" '[]'
	write_state "subagents.json" '{"active": [], "completed": []}'

	run_hook "post-tool-batch.sh" "$(subagent_grep_batch)"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Case 8: batch with only Read → no increment, no reminder
# ---------------------------------------------------------------------------

@test "post-tool-batch delegation reminder: read-only batch → no increment" {
	setup_usage_triggering
	write_state "active-agents.json" '[]'
	write_state "subagents.json" '{"active": [], "completed": []}'

	run_hook "post-tool-batch.sh" "$(read_batch)"
	assert_success
	assert_output ""
}
