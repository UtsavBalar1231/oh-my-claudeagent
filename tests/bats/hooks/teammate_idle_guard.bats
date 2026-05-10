#!/usr/bin/env bats
# Behavioral tests for teammate-idle-guard.sh

load '../test_helper'

IDLE_PAYLOAD='{"hook_event_name":"TeammateIdle","reason":"idle_prompt"}'

# ---------------------------------------------------------------------------
# a. No mode state → allow idle (exit 0)
# ---------------------------------------------------------------------------

@test "teammate-idle-guard: exits 0 (allows idle) when no mode files present" {
	rm -f "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json"
	rm -f "$CLAUDE_PROJECT_ROOT/.omca/state/ultrawork-state.json"

	run_hook "teammate-idle-guard.sh" "$IDLE_PAYLOAD"
	assert_success
}

# ---------------------------------------------------------------------------
# b. ralph active → block (exit 2)
# ---------------------------------------------------------------------------

@test "teammate-idle-guard: exits 2 (blocks) when ralph-state is active" {
	write_state "ralph-state.json" '{"status":"active","tasks":[]}'

	run_hook "teammate-idle-guard.sh" "$IDLE_PAYLOAD"
	assert_failure
	[ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# c. ultrawork active → block (exit 2)
# ---------------------------------------------------------------------------

@test "teammate-idle-guard: exits 2 (blocks) when ultrawork-state is active" {
	write_state "ultrawork-state.json" '{"status":"active"}'

	run_hook "teammate-idle-guard.sh" "$IDLE_PAYLOAD"
	assert_failure
	[ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# d. Named agent: multiple matches → picks most-recent started_epoch
# ---------------------------------------------------------------------------

@test "teammate-idle-guard: with multiple matching agents, uses most-recent started_epoch" {
	local now
	now=$(date +%s)
	local old_epoch=$((now - 500))
	local recent_epoch=$((now - 100))

	# Two agents of the same type; the most-recent has started_epoch = recent_epoch.
	# TIMEOUT_SECS defaults to 600, so neither agent should be timed out yet.
	write_state "subagents.json" \
		"{\"active\":[
			{\"id\":\"agent-old\",\"type\":\"oh-my-claudeagent:explore\",\"model\":\"sonnet\",\"started_epoch\":${old_epoch}},
			{\"id\":\"agent-new\",\"type\":\"oh-my-claudeagent:explore\",\"model\":\"sonnet\",\"started_epoch\":${recent_epoch}}
		]}"

	local payload
	payload=$(printf '{"hook_event_name":"TeammateIdle","teammate_name":"explore"}')

	# Script should allow idle (exit 0): most-recent agent started only ~100s ago, well under 600s.
	run_hook "teammate-idle-guard.sh" "$payload"
	assert_success
}

# ---------------------------------------------------------------------------
# e. Named agent: only oldest exceeds timeout → most-recent is checked, no stop
# ---------------------------------------------------------------------------

@test "teammate-idle-guard: oldest agent over timeout but most-recent is not — does not stop" {
	local now
	now=$(date +%s)
	# old_epoch would be timed out (700s ago), recent_epoch would not (100s ago).
	local old_epoch=$((now - 700))
	local recent_epoch=$((now - 100))

	write_state "subagents.json" \
		"{\"active\":[
			{\"id\":\"agent-old\",\"type\":\"oh-my-claudeagent:executor\",\"model\":\"sonnet\",\"started_epoch\":${old_epoch}},
			{\"id\":\"agent-new\",\"type\":\"oh-my-claudeagent:executor\",\"model\":\"sonnet\",\"started_epoch\":${recent_epoch}}
		]}"

	local payload
	payload=$(printf '{"hook_event_name":"TeammateIdle","teammate_name":"executor"}')

	# Most-recent agent is only 100s old — should NOT emit continue:false.
	run_hook "teammate-idle-guard.sh" "$payload"
	assert_success
	# Output must not contain continue:false
	[[ "$output" != *'"continue": false'* ]]
}

# ---------------------------------------------------------------------------
# f. Named agent: most-recent exceeds timeout → emits continue:false
# ---------------------------------------------------------------------------

@test "teammate-idle-guard: most-recent matching agent exceeds timeout — emits continue:false" {
	local now
	now=$(date +%s)
	# Both agents are stale; the most-recent started 700s ago — over the 600s threshold.
	local old_epoch=$((now - 900))
	local recent_epoch=$((now - 700))

	write_state "subagents.json" \
		"{\"active\":[
			{\"id\":\"agent-old\",\"type\":\"oh-my-claudeagent:explore\",\"model\":\"sonnet\",\"started_epoch\":${old_epoch}},
			{\"id\":\"agent-new\",\"type\":\"oh-my-claudeagent:explore\",\"model\":\"sonnet\",\"started_epoch\":${recent_epoch}}
		]}"

	local payload
	payload=$(printf '{"hook_event_name":"TeammateIdle","teammate_name":"explore"}')

	run_hook "teammate-idle-guard.sh" "$payload"
	assert_success
	# Output must contain continue:false because most-recent agent is over timeout.
	[[ "$output" == *'"continue": false'* ]]
}

# ---------------------------------------------------------------------------
# g. Unnamed (no teammate_name): multiple agents → uses most-recent overall
# ---------------------------------------------------------------------------

@test "teammate-idle-guard: no teammate_name uses most-recent agent across all types" {
	local now
	now=$(date +%s)
	local old_epoch=$((now - 800))
	local recent_epoch=$((now - 50))

	# One old agent and one very recent one; no teammate_name in payload.
	write_state "subagents.json" \
		"{\"active\":[
			{\"id\":\"agent-old\",\"type\":\"oh-my-claudeagent:explore\",\"model\":\"sonnet\",\"started_epoch\":${old_epoch}},
			{\"id\":\"agent-new\",\"type\":\"oh-my-claudeagent:executor\",\"model\":\"sonnet\",\"started_epoch\":${recent_epoch}}
		]}"

	run_hook "teammate-idle-guard.sh" "$IDLE_PAYLOAD"
	# Most-recent agent started only 50s ago — well under 600s timeout → allow idle.
	assert_success
	[[ "$output" != *'"continue": false'* ]]
}
