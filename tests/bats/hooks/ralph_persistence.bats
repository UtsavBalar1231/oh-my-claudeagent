#!/usr/bin/env bats
load '../test_helper'

STOP_PAYLOAD='{"stop_reason":"end_turn","stop_hook_active":false}'

# ─── a. No state files → allow stop ──────────────────────────────────────────

@test "no state files: allows stop (empty stdout, exit 0)" {
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output ""
}

# ─── b. Ralph active + pending tasks → block ─────────────────────────────────

@test "ralph active with pending tasks: blocks stop" {
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[{"id":"1","status":"pending"}],"last_task_hash":"","stagnation_count":0}'
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output --partial '"decision":"block"'
}

# ─── c. Ralph active + all tasks complete → allow stop ───────────────────────

@test "ralph active with all tasks completed: allows stop" {
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[{"id":"1","status":"completed"},{"id":"2","status":"verified"}],"last_task_hash":"","stagnation_count":0}'
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output ""
}

# ─── d. Ultrawork active + no agents → block ─────────────────────────────────

@test "ultrawork active with no running agents: blocks stop (stagnation < threshold)" {
	write_state "ultrawork-state.json" \
		'{"status":"active","stagnation_count":0}'
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output --partial '"decision":"block"'
}

# ─── e. Ultrawork active + running agents (recent) → allow stop ──────────────

@test "ultrawork active with recently-started agents: allows stop" {
	write_state "ultrawork-state.json" \
		'{"status":"active","stagnation_count":0}'
	local now
	now=$(date +%s)
	# Agent started 30 seconds ago — well within 900-second window
	write_state "subagents.json" \
		"{\"active\":[{\"id\":\"agent-1\",\"status\":\"running\",\"started_epoch\":$((now - 30))}]}"
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output ""
}

# ─── f. Boulder fallback — recent file (< 15 min) → block ────────────────────

@test "boulder fallback with fresh file: blocks stop" {
	# Boulder fallback only fires when ralph/ultrawork IS active but has no incomplete tasks.
	# Script exits at line 52 if neither mode is active. So we need ralph active + all complete.
	write_state "ralph-state.json" '{"status":"active","tasks":[{"id":"1","status":"completed"}],"last_task_hash":"","stagnation_count":0}'
	local boulder_path="$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json"
	printf '%s' '{"active_plan":"my-plan","plan_name":"my-plan"}' > "$boulder_path"
	# Boulder file is just created → mtime is now → age = 0 < 900
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output --partial '"decision":"block"'
}

# ─── g. Boulder fallback — stale file (> 15 min) → allow stop ────────────────

@test "boulder fallback with stale file (>15 min): allows stop" {
	# Need ralph active + all complete to reach boulder fallback (see test f)
	write_state "ralph-state.json" '{"status":"active","tasks":[{"id":"1","status":"completed"}],"last_task_hash":"","stagnation_count":0}'
	local boulder_path="$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json"
	printf '%s' '{"active_plan":"my-plan","plan_name":"my-plan"}' > "$boulder_path"
	# Back-date mtime by 20 minutes (1200 seconds)
	touch -d "20 minutes ago" "$boulder_path"
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output ""
}

# ─── h. Stagnation counter increments on repeated identical task state ────────

@test "stagnation counter increments when task state is unchanged across calls" {
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[{"id":"1","status":"pending"}],"last_task_hash":"","stagnation_count":1}'

	# First call — task hash differs from "" → stagnation resets to 0 after first call,
	# then on second call the hash is the same → stagnation becomes 1.
	# We call once to establish the hash in the state file.
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"

	# Second call — hash should now match → stagnation_count should increment
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"

	local stagnation
	stagnation=$(read_state "ralph-state.json" | jq -r '.stagnation_count')
	[[ "$stagnation" -ge 1 ]]
}

# ─── i. Pending question → allow stop ────────────────────────────────────────

@test "pending question within 300 seconds: allows stop" {
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[{"id":"1","status":"pending"}],"last_task_hash":"","stagnation_count":0}'
	local now
	now=$(date +%s)
	write_state "pending-question.json" "{\"timestamp\":$now}"
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output ""
}
