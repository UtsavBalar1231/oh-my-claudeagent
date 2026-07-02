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
	count=$(jq -r '."Agent:delegate_error".count // 0' "$counts_file")
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
	count=$(jq -r '."Agent:delegate_error".count // 0' "$counts_file")
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

# ─── error_count_bump: decay, legacy upgrade, timeline, cap ───────────────────

# Case 5: a last_failure_at older than the decay window resets count to 1 on next bump
@test "delegate-retry: stale last_failure_at (6min old) decays count back to 1" {
	local counts_file="$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json"
	local payload
	payload='{"tool_name":"Agent","tool_input":{"subagent_type":"oh-my-claudeagent:executor"},"error":"Agent failed: attempt"}'

	run_hook "delegate-retry.sh" "$payload"
	assert_success
	run_hook "delegate-retry.sh" "$payload"
	assert_success

	local count
	count=$(jq -r '."Agent:delegate_error".count' "$counts_file")
	assert [ "$count" -eq 2 ]

	# 360s (6min) — older than ERROR_COUNT_DECAY_SECONDS (300s), forces a clean-window reset.
	local stale_ts=$(( $(date +%s) - 360 ))
	jq --argjson ts "$stale_ts" '."Agent:delegate_error".last_failure_at = $ts' "$counts_file" > "$counts_file.tmp"
	mv "$counts_file.tmp" "$counts_file"

	run_hook "delegate-retry.sh" "$payload"
	assert_success

	count=$(jq -r '."Agent:delegate_error".count' "$counts_file")
	assert [ "$count" -eq 1 ]
}

# Case 6: legacy bare-int state is read without error and upgraded to object shape on write
@test "delegate-retry: legacy bare-int error-counts.json is read cleanly and upgraded" {
	local counts_file="$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json"
	write_state "error-counts.json" '{"Agent:delegate_error": 2}'

	local payload
	payload='{"tool_name":"Agent","tool_input":{"subagent_type":"oh-my-claudeagent:executor"},"error":"Agent failed: legacy"}'
	run_hook "delegate-retry.sh" "$payload"
	assert_success

	local count
	count=$(jq -r '."Agent:delegate_error".count' "$counts_file")
	assert [ "$count" -eq 3 ]

	local kind
	kind=$(jq -r '."Agent:delegate_error" | type' "$counts_file")
	assert [ "$kind" = "object" ]
}

# Case 7: breaker message at 3rd failure carries a compact attempt timeline
@test "delegate-retry: circuit-breaker message at 3rd failure contains attempt timeline" {
	local payload_a payload_b payload_c
	payload_a='{"tool_name":"Agent","tool_input":{"subagent_type":"oh-my-claudeagent:executor"},"error":"Agent failed: first issue"}'
	payload_b='{"tool_name":"Agent","tool_input":{"subagent_type":"oh-my-claudeagent:executor"},"error":"Agent failed: second issue"}'
	payload_c='{"tool_name":"Agent","tool_input":{"subagent_type":"oh-my-claudeagent:executor"},"error":"Agent failed: third issue"}'

	run_hook "delegate-retry.sh" "$payload_a"
	assert_success
	run_hook "delegate-retry.sh" "$payload_b"
	assert_success
	run_hook "delegate-retry.sh" "$payload_c"
	assert_success

	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -qi "Attempts:"
	echo "$ctx" | grep -qi "first issue"
	echo "$ctx" | grep -qi "second issue"
	echo "$ctx" | grep -qi "third issue"
}

# Case 8: last_errors is capped at 3 entries even after a 4th failure
@test "delegate-retry: last_errors array is capped at 3 entries" {
	local counts_file="$CLAUDE_PROJECT_ROOT/.omca/state/error-counts.json"
	local i payload
	for i in 1 2 3 4; do
		payload="{\"tool_name\":\"Agent\",\"tool_input\":{\"subagent_type\":\"oh-my-claudeagent:executor\"},\"error\":\"Agent failed: issue ${i}\"}"
		run_hook "delegate-retry.sh" "$payload"
		assert_success
	done

	local len
	len=$(jq -r '."Agent:delegate_error".last_errors | length' "$counts_file")
	assert [ "$len" -eq 3 ]

	# Newest-first: the most recent failure (issue 4) must be at index 0, oldest capped entry dropped.
	local newest
	newest=$(jq -r '."Agent:delegate_error".last_errors[0]' "$counts_file")
	echo "$newest" | grep -qi "issue 4"
}
