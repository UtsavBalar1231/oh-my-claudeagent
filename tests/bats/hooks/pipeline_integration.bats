#!/usr/bin/env bats
# Cross-script state pipeline integration tests
# These tests verify the STATE HANDOFF between hook scripts, not individual behavior.
# If script A changes its state file format, these tests catch the breakage in script B.

load '../test_helper'

# Override setup to use BATS_FILE_TMPDIR for cross-test persistence within pipeline sequences
setup() {
	export CLAUDE_PROJECT_ROOT="$BATS_FILE_TMPDIR/project"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/state"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/logs"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/rules"
	# Use _TEST_HELPER_DIR from test_helper.bash (resolved at load time, reliable)
	export CLAUDE_PLUGIN_ROOT="$(cd "$_TEST_HELPER_DIR/../.." && pwd)"
	export CLAUDE_SESSION_ID="bats-pipeline-session"
}

# ─── a. Keyword → Persistence pipeline ───────────────────────────────────────
# keyword-detector.sh writes ralph-state.json → ralph-persistence.sh reads it

@test "pipeline a: keyword-detector writes ralph-state, persistence reads and blocks" {
	# Step 1: run keyword-detector with a ralph prompt — it should create ralph-state.json
	run_hook "keyword-detector.sh" '{"prompt":"ralph"}'
	assert_success

	# Verify state handoff: ralph-state.json must now exist with status=active
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json" ]
	local status
	status=$(jq -r '.status' "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json")
	assert [ "$status" = "active" ]

	# Step 2: add a pending task so persistence has something to block on
	local ralph_state
	ralph_state=$(cat "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json")
	echo "$ralph_state" | jq '.tasks += [{"id":"t1","status":"pending"}]' \
		> "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json"

	# Step 3: run ralph-persistence — it reads ralph-state.json and should block
	run_hook "ralph-persistence.sh" '{"stop_reason":"end_turn","stop_hook_active":false}'
	assert_success
	assert_output --partial '"decision":"block"'
}

# ─── b. Keyword → modify tasks → Persistence allows ─────────────────────────
# Same pipeline but with all tasks completed → persistence should allow stop

@test "pipeline b: keyword-detector writes ralph-state, all tasks complete, persistence allows" {
	# Step 1: run keyword-detector to create ralph-state.json
	run_hook "keyword-detector.sh" '{"prompt":"ralph don'"'"'t stop"}'
	assert_success
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json" ]

	# Step 2: simulate all tasks completed (as an agent would update them)
	local ralph_state
	ralph_state=$(cat "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json")
	echo "$ralph_state" \
		| jq '.tasks = [{"id":"t1","status":"completed"},{"id":"t2","status":"verified"}]' \
		> "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json"

	# Step 3: run ralph-persistence — no incomplete tasks, should allow stop
	run_hook "ralph-persistence.sh" '{"stop_reason":"end_turn","stop_hook_active":false}'
	assert_success
	# Allow = empty output (no block decision)
	assert_output ""
}

# ─── c. Evidence → Task-Completion pipeline ──────────────────────────────────
# Write valid verification-evidence.json → task-completed-verify reads and allows

@test "pipeline c: valid fresh evidence allows task-completed-verify" {
	local now
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

	# Write valid verification-evidence.json with proper schema
	cat > "$CLAUDE_PROJECT_ROOT/.omca/state/verification-evidence.json" <<-EOF
	{
	  "entries": [
	    {
	      "type": "test",
	      "command": "just test",
	      "exit_code": 0,
	      "output_snippet": "10 tests passed",
	      "timestamp": "$now"
	    }
	  ]
	}
	EOF

	# task-completed-verify should allow (evidence is fresh and valid)
	run_hook "task-completed-verify.sh" '{"task_description":"verify tests pass"}'
	assert_success
}

# ─── d. No Evidence + recent edits → Task-Completion blocked ────────────────
# No evidence file + recent edits.jsonl → task-completed-verify blocks with exit 2

@test "pipeline d: no evidence with recent edits blocks task-completed-verify" {
	# Explicitly remove evidence from previous pipeline test (shared BATS_FILE_TMPDIR)
	rm -f "$CLAUDE_PROJECT_ROOT/.omca/state/verification-evidence.json"

	# Write a recent edits.jsonl so the hook knows files were modified
	local now
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	printf '{"event":"edit","file":"src/foo.ts","timestamp":"%s"}\n' "$now" \
		> "$CLAUDE_PROJECT_ROOT/.omca/logs/edits.jsonl"

	# task description matches verification keywords
	run_hook "task-completed-verify.sh" '{"task_description":"all tests pass after fix"}'
	# Should be blocked (exit 2)
	assert [ "$status" -eq 2 ]
}

# ─── e. Subagent tracking lifecycle ──────────────────────────────────────────
# track-subagent-spawn → subagent-start → subagent-complete → check subagents.json

@test "pipeline e: subagent tracking lifecycle across spawn, start, complete" {
	local spawn_payload='{"tool_name":"Agent","tool_input":{"prompt":"test task","subagent_type":"oh-my-claudeagent:explore"}}'
	local start_payload='{"agent_id":"test-agent-001","agent_type":"oh-my-claudeagent:explore"}'
	local stop_payload='{"agent_id":"test-agent-001","agent_type":"oh-my-claudeagent:explore"}'

	# Step 1: track-subagent-spawn writes a spawn-* entry to subagents.json
	run_hook "track-subagent-spawn.sh" "$spawn_payload"
	assert_success
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/subagents.json" ]

	local active_count
	active_count=$(jq '[.active[]] | length' "$CLAUDE_PROJECT_ROOT/.omca/state/subagents.json")
	assert [ "$active_count" -ge 1 ]

	# Verify it got a spawn-* prefixed id (not the final platform id yet)
	local spawn_id
	spawn_id=$(jq -r '.active[0].id' "$CLAUDE_PROJECT_ROOT/.omca/state/subagents.json")
	# Should start with "spawn-"
	[[ "$spawn_id" == spawn-* ]]

	# Step 2: subagent-start bridges spawn-* → platform agent_id in subagents.json
	# It also registers in active-agents.json
	run_hook "subagent-start.sh" "$start_payload"
	assert_success

	# After subagent-start, active-agents.json should contain the platform agent id
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/active-agents.json" ]
	local agent_in_active
	agent_in_active=$(jq --arg id "test-agent-001" '[.[] | select(.id == $id)] | length' \
		"$CLAUDE_PROJECT_ROOT/.omca/state/active-agents.json")
	assert [ "$agent_in_active" -eq 1 ]

	# The spawn-* entry in subagents.json should now have been bridged to platform id
	local updated_id
	updated_id=$(jq -r '.active[0].id' "$CLAUDE_PROJECT_ROOT/.omca/state/subagents.json")
	assert [ "$updated_id" = "test-agent-001" ]

	# Step 3: subagent-complete removes from active, adds to completed
	run_hook "subagent-complete.sh" "$stop_payload"
	assert_success

	# active list should be empty for this agent
	local remaining_active
	remaining_active=$(jq --arg id "test-agent-001" '[.active[] | select(.id == $id)] | length' \
		"$CLAUDE_PROJECT_ROOT/.omca/state/subagents.json")
	assert [ "$remaining_active" -eq 0 ]

	# completed list should have the agent
	local completed_count
	completed_count=$(jq --arg id "test-agent-001" '[.completed[] | select(.id == $id)] | length' \
		"$CLAUDE_PROJECT_ROOT/.omca/state/subagents.json")
	assert [ "$completed_count" -ge 1 ]

	# active-agents.json should no longer contain the agent
	local agent_still_active
	agent_still_active=$(jq --arg id "test-agent-001" '[.[] | select(.id == $id)] | length' \
		"$CLAUDE_PROJECT_ROOT/.omca/state/active-agents.json")
	assert [ "$agent_still_active" -eq 0 ]
}

# ─── f. Full compaction survival pipeline ────────────────────────────────────
# Write ralph + boulder state → pre-compact → verify compaction-context.md → post-compact-inject → verify output + cleanup

@test "pipeline f: compaction survival — pre-compact writes context, post-compact-inject restores" {
	# Write ralph-state.json (active)
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[],"last_task_hash":"","stagnation_count":0}'

	# Write boulder.json with active plan reference
	write_state "boulder.json" \
		'{"active_plan":"/home/user/plans/my-plan.md","plan_name":"my-plan"}'

	# Step 1: run pre-compact — reads state, writes compaction-context.md
	run_hook "pre-compact.sh" '{}'
	assert_success

	local context_file="$CLAUDE_PROJECT_ROOT/.omca/state/compaction-context.md"
	assert [ -f "$context_file" ]

	# Compaction-context.md must contain ralph mode indicator
	run grep -i "ralph" "$context_file"
	assert_success

	# Must also reference the active plan
	run grep -i "my-plan" "$context_file"
	assert_success

	# Step 2: run post-compact-inject — reads compaction-context.md, emits additionalContext, deletes the file
	run_hook "post-compact-inject.sh" '{"session_id":"bats-pipeline-session"}'
	assert_success

	# Output must contain the post-compaction restore marker
	assert_output --partial "POST-COMPACTION CONTEXT RESTORE"

	# The context must include ralph mode information (passed through from pre-compact)
	assert_output --partial "Ralph"

	# compaction-context.md must be deleted after injection (consumed)
	assert [ ! -f "$context_file" ]
}

# ─── g. Context cache persistence pipeline ──────────────────────────────────
# context-injector for dir A → injected (cached) → dir A again → NOT injected → dir B → injected

@test "pipeline g: context-injector caches dir A, skips on second call, injects dir B" {
	# Create dir A with an AGENTS.md file
	local dir_a="$CLAUDE_PROJECT_ROOT/src/module-a"
	mkdir -p "$dir_a"
	printf '# AGENTS.md for module-a\nUse the standard patterns.\n' > "$dir_a/AGENTS.md"

	# Create a dummy file in dir A to simulate reading it
	printf 'export const foo = 1;\n' > "$dir_a/index.ts"

	# Create dir B with an AGENTS.md file
	local dir_b="$CLAUDE_PROJECT_ROOT/src/module-b"
	mkdir -p "$dir_b"
	printf '# AGENTS.md for module-b\nUse the module-b patterns.\n' > "$dir_b/AGENTS.md"
	printf 'export const bar = 2;\n' > "$dir_b/index.ts"

	local cache_file="$CLAUDE_PROJECT_ROOT/.omca/state/injected-context-dirs.json"

	# Step 1: Read from dir A — should inject AGENTS.md content (not yet cached)
	run_hook "context-injector.sh" \
		"{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$dir_a/index.ts\"}}"
	assert_success
	# Should produce context output (AGENTS.md injected)
	assert_output --partial "AGENTS.md from"
	assert_output --partial "module-a"

	# Cache file should now record dir A as injected
	assert [ -f "$cache_file" ]
	local dir_a_cached
	dir_a_cached=$(jq -r --arg d "$dir_a" '.[$d] // "false"' "$cache_file")
	assert [ "$dir_a_cached" = "true" ]

	# Step 2: Read from dir A again — should NOT inject (already cached)
	run_hook "context-injector.sh" \
		"{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$dir_a/index.ts\"}}"
	assert_success
	# No AGENTS.md context should be produced for dir A this time
	refute_output --partial "module-a"

	# Step 3: Read from dir B — should inject AGENTS.md (not yet cached)
	run_hook "context-injector.sh" \
		"{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$dir_b/index.ts\"}}"
	assert_success
	assert_output --partial "AGENTS.md from"
	assert_output --partial "module-b"

	# Cache file should now record dir B as injected too
	local dir_b_cached
	dir_b_cached=$(jq -r --arg d "$dir_b" '.[$d] // "false"' "$cache_file")
	assert [ "$dir_b_cached" = "true" ]
}
