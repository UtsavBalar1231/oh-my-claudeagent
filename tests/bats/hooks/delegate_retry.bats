#!/usr/bin/env bats
load '../test_helper'

# ─── delegate-retry.sh counter and migration tests ────────────────────────────

# Case 1: counter increment — Agent tool name → Agent:delegate_error incremented
@test "delegate-retry: Agent tool failure increments Agent:delegate_error counter" {
	local payload
	payload='{"tool_name":"Agent","tool_input":{"subagent_type":"oh-my-claudeagent:executor"},"error":"Agent failed: some error"}'
	run_hook "delegate-retry.sh" "$payload"
	assert_success

	local counts_file="$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json"
	assert [ -f "$counts_file" ]

	local count
	count=$(jq -r '."Agent:delegate_error" // 0' "$counts_file")
	assert [ "$count" -eq 1 ]
}

# Case 1b: counter accumulates across multiple calls
@test "delegate-retry: counter increments cumulatively on repeated failures" {
	local payload
	payload='{"tool_name":"Agent","tool_input":{"subagent_type":"oh-my-claudeagent:executor"},"error":"Agent failed: some error"}'

	run_hook "delegate-retry.sh" "$payload"
	assert_success
	run_hook "delegate-retry.sh" "$payload"
	assert_success

	local counts_file="$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json"
	local count
	count=$(jq -r '."Agent:delegate_error" // 0' "$counts_file")
	assert [ "$count" -eq 2 ]
}

# Case 1c: no Task:delegate_error key written for Agent tool calls
@test "delegate-retry: Agent tool failure does not write Task:delegate_error key" {
	local payload
	payload='{"tool_name":"Agent","tool_input":{"subagent_type":"oh-my-claudeagent:executor"},"error":"Agent failed: some error"}'
	run_hook "delegate-retry.sh" "$payload"
	assert_success

	local counts_file="$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json"
	local task_count
	task_count=$(jq -r '."Task:delegate_error" // "absent"' "$counts_file")
	assert [ "$task_count" = "absent" ]
}

# Case 2: legacy migration — Task:delegate_error key merged into Agent:delegate_error
@test "session-init: migrates Task:delegate_error into Agent:delegate_error" {
	write_state "error-counts.json" '{"Task:delegate_error": 3}'

	local payload='{"source":"startup"}'
	run_hook "session-init.sh" "$payload"
	assert_success

	local counts_file="$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json"
	assert [ -f "$counts_file" ]

	# Legacy key must be removed
	local has_task
	has_task=$(jq 'has("Task:delegate_error")' "$counts_file")
	assert [ "$has_task" = "false" ]

	# Value merged into Agent key
	local agent_count
	agent_count=$(jq -r '."Agent:delegate_error" // 0' "$counts_file")
	assert [ "$agent_count" -eq 3 ]
}

# Case 2b: migration sums when both keys exist
@test "session-init: migration sums Task and Agent counts when both keys exist" {
	write_state "error-counts.json" '{"Task:delegate_error": 3, "Agent:delegate_error": 2}'

	local payload='{"source":"startup"}'
	run_hook "session-init.sh" "$payload"
	assert_success

	local counts_file="$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json"

	local has_task
	has_task=$(jq 'has("Task:delegate_error")' "$counts_file")
	assert [ "$has_task" = "false" ]

	local agent_count
	agent_count=$(jq -r '."Agent:delegate_error" // 0' "$counts_file")
	assert [ "$agent_count" -eq 5 ]
}

# Case 3: idempotency — no Task: keys → session-init does not write/modify the file
@test "session-init: no migration when Task:delegate_error key absent (idempotent)" {
	# Pre-seed the counts file with only Agent key — should not be touched by migration
	write_state "error-counts.json" '{"Agent:delegate_error": 7}'
	local before_mtime
	before_mtime=$(stat -c '%Y' "$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json")

	local payload='{"source":"startup"}'
	run_hook "session-init.sh" "$payload"
	assert_success

	local after_mtime
	after_mtime=$(stat -c '%Y' "$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json")

	# mtime must not change — migration must not touch the file
	assert [ "$before_mtime" = "$after_mtime" ]

	# Agent count unchanged
	local agent_count
	agent_count=$(jq -r '."Agent:delegate_error"' "$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json")
	assert [ "$agent_count" -eq 7 ]
}

# Case 3b: no counts file → session-init does not create it (migration is fully guarded)
@test "session-init: no migration when error-counts.json does not exist" {
	# Ensure file does not exist
	rm -f "$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json"

	local payload='{"source":"startup"}'
	run_hook "session-init.sh" "$payload"
	assert_success

	# File should still not exist (session-init does not create it)
	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json" ]
}

# Case 4: corrupt counts file → delegate-retry does NOT overwrite with single-key object
@test "delegate-retry: corrupt error-counts.json is left unchanged on jq failure" {
	local counts_file="$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json"
	local corrupt_content='THIS IS NOT JSON {'
	write_state "error-counts.json" "$corrupt_content"

	local payload
	payload='{"tool_name":"Agent","tool_input":{"subagent_type":"oh-my-claudeagent:executor"},"error":"Agent failed: some error"}'
	run_hook "delegate-retry.sh" "$payload"
	# Hook must not crash fatally — exit 0 is expected (graceful degradation)
	assert_success

	# File must not have been overwritten with a single-key object
	local actual
	actual=$(cat "$counts_file")
	assert [ "$actual" = "$corrupt_content" ]
}
