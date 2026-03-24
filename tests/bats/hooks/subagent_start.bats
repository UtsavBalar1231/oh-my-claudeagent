#!/usr/bin/env bats
load '../test_helper'

# Base payloads
EXPLORE_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"oh-my-claudeagent:explore"}'
SISYPHUS_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"oh-my-claudeagent:sisyphus"}'
ATLAS_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"oh-my-claudeagent:atlas"}'
UNKNOWN_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"custom-agent"}'

# ─── a. Agent Protocol injection ─────────────────────────────────────────────

@test "agent protocol: output contains AskUserQuestion unavailability notice" {
	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "AskUserQuestion"
}

# ─── b. Current Date injection ───────────────────────────────────────────────

@test "current date: output contains [CURRENT DATE] block" {
	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "\[CURRENT DATE\]"
}

# ─── c. Output Mandate injection ─────────────────────────────────────────────

@test "output mandate: output contains OUTPUT MANDATE directive" {
	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "OUTPUT MANDATE"
}

# ─── d. Boulder plan context — present ───────────────────────────────────────

@test "boulder plan context: READ-ONLY and NOTEPAD injected when boulder.json exists" {
	# Create a plan file the boulder references
	local plan_dir="$BATS_TEST_TMPDIR/plans"
	mkdir -p "$plan_dir"
	local plan_file="$plan_dir/my-plan.md"
	printf '# My Plan\n- task 1\n' > "$plan_file"

	write_state "boulder.json" \
		"{\"active_plan\":\"${plan_file}\",\"plan_name\":\"my-plan\"}"

	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "READ-ONLY"
	echo "$ctx" | grep -q "NOTEPAD"
}

# ─── e. No boulder = no plan context ─────────────────────────────────────────

@test "no boulder.json: plan context (READ-ONLY) is absent" {
	# Ensure no boulder.json exists (clean state from setup)
	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	# Should NOT contain READ-ONLY when boulder absent
	! echo "$ctx" | grep -q "READ-ONLY"
}

# ─── f. Ralph mode injection ─────────────────────────────────────────────────

@test "ralph mode: active ralph-state.json causes mode mention in output" {
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[],"last_task_hash":"","stagnation_count":0}'

	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	# Should mention ralph mode
	echo "$ctx" | grep -qi "ralph"
}

# ─── g. Active agents tracking ───────────────────────────────────────────────

@test "active agents tracking: active-agents.json is created after SubagentStart" {
	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	[[ -f "$CLAUDE_PROJECT_ROOT/.omca/state/active-agents.json" ]]
}

# ─── h. Anti-duplication for orchestrator agents ─────────────────────────────

@test "anti-duplication: sisyphus agent receives ANTI-DUPLICATION guidance" {
	run_hook "subagent-start.sh" "$SISYPHUS_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "ANTI-DUPLICATION"
}

# ─── i. Agent catalog for orchestrators ──────────────────────────────────────

@test "agent catalog stale: atlas agent without catalog.json gets CATALOG STALE notice" {
	run_hook "subagent-start.sh" "$ATLAS_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	# Without an agent-catalog.json, the script injects CATALOG STALE
	echo "$ctx" | grep -q "CATALOG STALE"
}

@test "agent catalog: atlas agent with catalog.json gets dynamic delegation table" {
	# Write a minimal agent-catalog.json
	write_state "agent-catalog.json" \
		'[{"name":"explore","cost_tier":"haiku","when_to_use":"codebase search and discovery","default_model":"haiku"}]'

	run_hook "subagent-start.sh" "$ATLAS_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "DYNAMIC AGENT CATALOG"
}
