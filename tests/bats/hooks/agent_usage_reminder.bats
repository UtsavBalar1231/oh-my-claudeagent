#!/usr/bin/env bats
# Behavioral tests for agent-usage-reminder.sh — union-read race fix

load '../test_helper'

# ---------------------------------------------------------------------------
# Helper: write agent-usage.json so the reminder fires after the +1 increment.
# The hook does toolCallCount += 1 then checks (count % 3 == 0).
# Starting at 2 → increments to 3 → 3 % 3 == 0 → reminder fires.
# ---------------------------------------------------------------------------
setup_usage_triggering() {
	write_state "agent-usage.json" '{"agentUsed": false, "toolCallCount": 2}'
}

# ---------------------------------------------------------------------------
# Case 1: same agent ID in both files → unioned count = 1, suppressed
# ---------------------------------------------------------------------------

@test "agent-usage-reminder: both files share same ID → suppressed (count=1)" {
	setup_usage_triggering
	write_state "active-agents.json" '[{"id": "agent-abc", "agent": "explore"}]'
	write_state "subagents.json" '{"active": [{"id": "agent-abc", "type": "explore"}], "completed": []}'

	run_hook "agent-usage-reminder.sh" '{}'
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Case 2: only subagents.json has the agent (SubagentStart hasn't fired yet)
# ---------------------------------------------------------------------------

@test "agent-usage-reminder: only subagents.json has agent → suppressed (count=1)" {
	setup_usage_triggering
	write_state "active-agents.json" '[]'
	write_state "subagents.json" '{"active": [{"id": "spawn-001", "type": "explore"}], "completed": []}'

	run_hook "agent-usage-reminder.sh" '{}'
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Case 3: only active-agents.json has the agent (other race ordering)
# ---------------------------------------------------------------------------

@test "agent-usage-reminder: only active-agents.json has agent → suppressed (count=1)" {
	setup_usage_triggering
	write_state "active-agents.json" '[{"id": "agent-xyz", "agent": "librarian"}]'
	write_state "subagents.json" '{"active": [], "completed": []}'

	run_hook "agent-usage-reminder.sh" '{}'
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Case 4: both files empty → unioned count = 0, reminder fires
# ---------------------------------------------------------------------------

@test "agent-usage-reminder: both files empty → reminder fires" {
	setup_usage_triggering
	write_state "active-agents.json" '[]'
	write_state "subagents.json" '{"active": [], "completed": []}'

	run_hook "agent-usage-reminder.sh" '{}'
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "DELEGATION REMINDER"
}

# ---------------------------------------------------------------------------
# Case 5: neither file exists → unioned count = 0, reminder fires
# ---------------------------------------------------------------------------

@test "agent-usage-reminder: state files absent → reminder fires" {
	setup_usage_triggering

	run_hook "agent-usage-reminder.sh" '{}'
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "DELEGATION REMINDER"
}

# ---------------------------------------------------------------------------
# Case 6: agentUsed=true → exits before reminder regardless of count
# ---------------------------------------------------------------------------

@test "agent-usage-reminder: agentUsed=true → no reminder" {
	write_state "agent-usage.json" '{"agentUsed": true, "toolCallCount": 3}'
	write_state "active-agents.json" '[]'
	write_state "subagents.json" '{"active": [], "completed": []}'

	run_hook "agent-usage-reminder.sh" '{}'
	assert_success
	assert_output ""
}
