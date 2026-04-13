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

# ─── j. Plan-file-aware stagnation: 3 unchanged invocations → escalates ──────

@test "plan stagnation: mtime+hash unchanged across 3+ calls → plan_stagnation_count reaches 3" {
	# Use no-tasks state so MAX_STAGNATION=5 (task-hash stagnation won't fire first)
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[],"last_task_hash":"","stagnation_count":0,"plan_stagnation_count":0}'

	# Create a plan file with incomplete checkboxes
	local plan_file="$CLAUDE_PROJECT_ROOT/plans/test-plan.md"
	mkdir -p "$CLAUDE_PROJECT_ROOT/plans"
	printf '## TODOs\n- [ ] 1. First task\n- [ ] 2. Second task\n' > "$plan_file"

	# Point boulder.json at the plan file (absolute path)
	write_state "boulder.json" \
		"{\"active_plan\":\"${plan_file}\",\"plan_name\":\"test-plan\"}"

	# Call 1: establishes task hash and plan mtime; plan_stagnation stays 0
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"

	# Call 2: task hash matches → STAGNATION=1; plan mtime unchanged → plan_stagnation=1
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"

	# Call 3: STAGNATION=2; plan_stagnation=2
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"

	# Call 4: STAGNATION=3; plan_stagnation=3 → plan escalation fires (exits 0, allows stop)
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success

	local psc
	psc=$(read_state "ralph-state.json" | jq -r '.plan_stagnation_count')
	[[ "$psc" -ge 3 ]]
}

# ─── k. Plan-file-aware stagnation: missing boulder → no-op ──────────────────

@test "plan stagnation: no boulder.json → skips plan tracking silently" {
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[{"id":"1","status":"pending"}],"last_task_hash":"","stagnation_count":0}'
	# No boulder.json present — should behave exactly like baseline (blocks stop)
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output --partial '"decision":"block"'
}

# ─── l. Plan-file-aware stagnation: all checkboxes complete → no increment ───

@test "plan stagnation: all checkboxes complete → plan_stagnation_count stays 0" {
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[],"last_task_hash":"","stagnation_count":0,"plan_stagnation_count":0}'

	local plan_file="$CLAUDE_PROJECT_ROOT/plans/complete-plan.md"
	mkdir -p "$CLAUDE_PROJECT_ROOT/plans"
	printf '## TODOs\n- [x] 1. Done task\n- [x] 2. Also done\n' > "$plan_file"

	write_state "boulder.json" \
		"{\"active_plan\":\"${plan_file}\",\"plan_name\":\"complete-plan\"}"

	# Multiple calls — no incomplete checkboxes, so plan_stagnation must not increment
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"

	local psc
	psc=$(read_state "ralph-state.json" | jq -r '.plan_stagnation_count // 0')
	[[ "$psc" -eq 0 ]]
}
