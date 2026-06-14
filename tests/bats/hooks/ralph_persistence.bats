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
		'{"status":"active","tasks":[{"id":"1","status":"pending"}],"idle_count":0}'
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output --partial '"decision":"block"'
}

# ─── c. Ralph active + all tasks complete (no plan) → allow stop ─────────────

@test "ralph active with all tasks completed: allows stop" {
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[{"id":"1","status":"completed"},{"id":"2","status":"verified"}],"idle_count":0}'
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output ""
}

# ─── d. Ultrawork active + no agents → block ─────────────────────────────────

@test "ultrawork active with no running agents: blocks stop" {
	write_state "ultrawork-state.json" '{"status":"active","idle_count":0}'
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output --partial '"decision":"block"'
}

# ─── e. Ultrawork active + running agents (recent) → allow stop ──────────────

@test "ultrawork active with recently-started agents: allows stop" {
	write_state "ultrawork-state.json" '{"status":"active","idle_count":0}'
	local now
	now=$(date +%s)
	write_state "subagents.json" \
		"{\"active\":[{\"id\":\"agent-1\",\"status\":\"running\",\"started_epoch\":$((now - 30))}]}"
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output ""
}

# ─── f. Ralph + incomplete plan checkbox → block (authoritative truth) ───────

@test "ralph active with incomplete plan checkbox: blocks stop" {
	write_state "ralph-state.json" '{"status":"active","tasks":[],"idle_count":0}'
	local plan_file="$CLAUDE_PROJECT_ROOT/plans/p.md"
	mkdir -p "$CLAUDE_PROJECT_ROOT/plans"
	printf '# Plan\n- [ ] 1. Task A\n' > "$plan_file"
	write_state "boulder.json" "{\"active_plan\":\"${plan_file}\",\"plan_name\":\"p\"}"
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output --partial '"decision":"block"'
}

# ─── g. Ralph + all plan checkboxes complete (no tasks) → allow stop ─────────

@test "ralph active with all plan checkboxes complete: allows stop" {
	write_state "ralph-state.json" '{"status":"active","tasks":[],"idle_count":0}'
	local plan_file="$CLAUDE_PROJECT_ROOT/plans/done.md"
	mkdir -p "$CLAUDE_PROJECT_ROOT/plans"
	printf '# Plan\n- [x] 1. Done\n- [x] 2. Done\n' > "$plan_file"
	write_state "boulder.json" "{\"active_plan\":\"${plan_file}\",\"plan_name\":\"done\"}"
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output ""
}

# ─── h. Ralph + boulder points at a missing plan file → allow stop ──────────

@test "ralph with boulder pointing to missing plan file: allows stop and deactivates" {
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[{"id":"1","status":"pending"}],"idle_count":0}'
	write_state "boulder.json" \
		'{"active_plan":"/tmp/nonexistent-plan-12345.md","plan_name":"ghost-plan"}'
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output ""
	local status
	status=$(read_state "ralph-state.json" | jq -r '.status')
	[[ "$status" == "inactive" ]]
}

# ─── i. Pending question → allow stop ────────────────────────────────────────

@test "pending question within 300 seconds: allows stop" {
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[{"id":"1","status":"pending"}],"idle_count":0}'
	local now
	now=$(date +%s)
	write_state "pending-question.json" "{\"timestamp\":$now}"
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	assert_output ""
}

# ─── j. Monotonic cap: cap-1 consecutive blocks → yield (allow) ──────────────

@test "monotonic cap: cap=4 → blocks twice then yields on the 3rd consecutive block" {
	export CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=4
	write_state "ralph-state.json" '{"status":"active","tasks":[],"idle_count":0}'
	local plan_file="$BATS_TEST_TMPDIR/cap.md"
	printf '# Plan\n- [ ] 1. A\n- [ ] 2. B\n' > "$plan_file"
	write_state "boulder.json" "{\"active_plan\":\"${plan_file}\",\"plan_name\":\"cap\"}"

	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_output --partial '"decision":"block"'
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_output --partial '"decision":"block"'
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_success
	refute_output --partial '"decision":"block"'
	assert_output --partial 'yielding to platform'

	unset CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
}

# ─── k. Monotonic cap: progress does NOT reset the counter (churn-proof) ─────

@test "monotonic cap: completing a checkbox does NOT reset the counter — still yields at cap-1" {
	export CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=4
	write_state "ralph-state.json" '{"status":"active","tasks":[],"idle_count":0}'
	local plan_file="$BATS_TEST_TMPDIR/churn.md"
	printf '# Plan\n- [ ] 1. A\n- [ ] 2. B\n' > "$plan_file"
	write_state "boulder.json" "{\"active_plan\":\"${plan_file}\",\"plan_name\":\"churn\"}"

	# Call 1: block (count 1)
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_output --partial '"decision":"block"'
	# Simulate progress — complete one checkbox. The legacy code reset the counter here;
	# the monotonic counter must NOT.
	printf '# Plan\n- [x] 1. A\n- [ ] 2. B\n' > "$plan_file"
	# Call 2: block (count 2)
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_output --partial '"decision":"block"'
	# Call 3: count reaches cap-1=3 → yields despite the progress
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	refute_output --partial '"decision":"block"'
	assert_output --partial 'yielding to platform'

	unset CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
}

# ─── l. Idle deactivation: no-work ralph self-deactivates after IDLE_MAX ─────

@test "idle deactivation: ralph active with no work for IDLE_MAX stops → deactivates" {
	write_state "ralph-state.json" '{"status":"active","tasks":[],"idle_count":0}'
	# No tasks, no plan → no work each turn. IDLE_MAX is 5.
	for _ in 1 2 3 4 5; do
		run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
		assert_success
		assert_output ""
	done
	local status
	status=$(read_state "ralph-state.json" | jq -r '.status')
	[[ "$status" == "inactive" ]]
}

# ─── m. Ultrawork bounded: no agents, cap consecutive blocks → yield+deactivate ─

@test "ultrawork bounded: cap=4 no-agents blocks then yields and deactivates ultrawork" {
	export CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=4
	write_state "ultrawork-state.json" '{"status":"active","idle_count":0}'
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_output --partial '"decision":"block"'
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	assert_output --partial '"decision":"block"'
	run_hook "ralph-persistence.sh" "$STOP_PAYLOAD"
	refute_output --partial '"decision":"block"'
	local status
	status=$(read_state "ultrawork-state.json" | jq -r '.status')
	[[ "$status" == "inactive" ]]
	unset CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
}

# ─── n. Recursion guard: stop_hook_active=true → allow stop ──────────────────

@test "recursion guard: stop_hook_active true → allows stop even with incomplete work" {
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[{"id":"1","status":"pending"}],"idle_count":0}'
	run_hook "ralph-persistence.sh" '{"stop_reason":"end_turn","stop_hook_active":true}'
	assert_success
	assert_output ""
}

# ─── o. background_tasks in payload → orthogonal (still blocks) ──────────────

@test "stop payload: background_tasks does not affect ralph blocking decision" {
	local BG_PAYLOAD='{"stop_reason":"end_turn","stop_hook_active":false,"background_tasks":[{"id":"bg-1","status":"running"}],"session_crons":[]}'
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[{"id":"1","status":"pending"}],"idle_count":0}'
	run_hook "ralph-persistence.sh" "$BG_PAYLOAD"
	assert_success
	assert_output --partial '"decision":"block"'

	rm -f "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json"
	run_hook "ralph-persistence.sh" "$BG_PAYLOAD"
	assert_success
	assert_output ""
}
