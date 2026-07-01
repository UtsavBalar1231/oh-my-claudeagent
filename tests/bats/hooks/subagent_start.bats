#!/usr/bin/env bats
load '../test_helper'

# Base payloads
EXPLORE_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"oh-my-claudeagent:explore"}'
SISYPHUS_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"oh-my-claudeagent:sisyphus"}'
PROMETHEUS_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"oh-my-claudeagent:prometheus"}'
UNKNOWN_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"custom-agent"}'
EXECUTOR_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"oh-my-claudeagent:executor"}'
LIBRARIAN_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"oh-my-claudeagent:librarian"}'
HEPHAESTUS_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"oh-my-claudeagent:hephaestus"}'
MOMUS_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"oh-my-claudeagent:momus"}'
ORACLE_PAYLOAD='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"oh-my-claudeagent:oracle"}'

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

# ─── h. Anti-duplication for orchestrator agents ─────────────────────────────

@test "anti-duplication: sisyphus agent receives ANTI-DUPLICATION guidance" {
	run_hook "subagent-start.sh" "$SISYPHUS_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "ANTI-DUPLICATION"
}

# ─── i. Agent catalog for orchestrators ──────────────────────────────────────

@test "agent catalog stale: sisyphus agent without catalog.json gets CATALOG STALE notice" {
	run_hook "subagent-start.sh" "$SISYPHUS_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	# Without an agent-catalog.json, the script injects CATALOG STALE
	echo "$ctx" | grep -q "CATALOG STALE"
}

@test "agent catalog: sisyphus agent with catalog.json gets dynamic delegation table" {
	# Write a minimal agent-catalog.json
	write_state "agent-catalog.json" \
		'[{"name":"explore","cost_tier":"haiku","when_to_use":"codebase search and discovery","default_model":"haiku"}]'

	run_hook "subagent-start.sh" "$SISYPHUS_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "DYNAMIC AGENT CATALOG"
}

# ─── j. Blocking questions protocol injection ─────────────────────────────────

@test "blocking questions: planner agents receive BLOCKING QUESTIONS protocol" {
	run_hook "subagent-start.sh" "$PROMETHEUS_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "BLOCKING QUESTIONS"
}

@test "blocking questions: non-planner agents receive BLOCKING QUESTIONS protocol" {
	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "BLOCKING QUESTIONS"
}

@test "blocking questions: hook no longer mentions notepad questions section" {
	# Run against both a planner (prometheus) and a non-planner (explore)
	# to catch any regression in either branch of the case statement.
	run_hook "subagent-start.sh" "$PROMETHEUS_PAYLOAD"
	assert_success
	local ctx_p
	ctx_p=$(get_context)
	! echo "$ctx_p" | grep -qE "notepad.*questions.*section|questions' when you need"

	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx_e
	ctx_e=$(get_context)
	! echo "$ctx_e" | grep -qE "notepad.*questions.*section|questions' when you need"
}

# ─── k. Missing plan file → skip plan injection, keep notepad ────────────────

@test "subagent-start skips plan injection when plan file missing" {
	write_state "boulder.json" \
		'{"active_plan":"/tmp/nonexistent-plan-12345.md","plan_name":"ghost-plan"}'
	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	! echo "$ctx" | grep -q '\[ACTIVE PLAN\]'
	echo "$ctx" | grep -q '\[NOTEPAD AVAILABLE\]'
}

# ─── l. Blocking questions: notepad sections list excludes questions ─────────

@test "blocking questions: notepad sections list excludes questions" {
	# With a boulder plan set, the NOTEPAD AVAILABLE line lists sections.
	local plan_dir="$BATS_TEST_TMPDIR/plans"
	mkdir -p "$plan_dir"
	local plan_file="$plan_dir/my-plan.md"
	printf '# My Plan\n- task 1\n' >"$plan_file"

	write_state "boulder.json" \
		"{\"active_plan\":\"${plan_file}\",\"plan_name\":\"my-plan\"}"

	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	# The sections list should mention the 4 retained sections but not "questions"
	echo "$ctx" | grep -q "learnings, issues, decisions, problems"
	! echo "$ctx" | grep -q "learnings, issues, decisions, problems, questions"
}

# ─── n. Worker counter-instruction — presence for worker roles ───────────────

@test "counter-instruction: executor agent receives worker counter-instruction" {
	run_hook "subagent-start.sh" "$EXECUTOR_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "YOU ARE A LEAF WORKER"
}

@test "counter-instruction: explore agent receives worker counter-instruction" {
	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "YOU ARE A LEAF WORKER"
}

@test "counter-instruction: librarian agent receives worker counter-instruction" {
	run_hook "subagent-start.sh" "$LIBRARIAN_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "YOU ARE A LEAF WORKER"
}

@test "counter-instruction: hephaestus agent receives worker counter-instruction" {
	run_hook "subagent-start.sh" "$HEPHAESTUS_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "YOU ARE A LEAF WORKER"
}

# ─── o. Worker counter-instruction — absence for non-worker roles ─────────────

@test "counter-instruction: sisyphus agent does NOT receive worker counter-instruction" {
	run_hook "subagent-start.sh" "$SISYPHUS_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	! echo "$ctx" | grep -q "YOU ARE A LEAF WORKER"
}

# momus and oracle are advisory WORKERS, not orchestrators — they coordinate no other
# agents and must receive the exemption so a finished advisor is never told to wait
# ("Done. Ending." loop). Only sisyphus/prometheus/metis (true orchestrators) are excluded.
@test "counter-instruction: momus agent receives worker counter-instruction (advisors are workers)" {
	run_hook "subagent-start.sh" "$MOMUS_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "YOU ARE A LEAF WORKER"
}

@test "counter-instruction: oracle agent receives worker counter-instruction (advisors are workers)" {
	run_hook "subagent-start.sh" "$ORACLE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "YOU ARE A LEAF WORKER"
}

# ─── p. Registry resolution via the boulder_resolve.py shim ─────────────────
# CLAUDE_SESSION_ID is fixed to "bats-test-session" by test_helper's setup().
# The corpus fixtures reference plan paths under /home/user/.claude/plans,
# which don't exist on the test box — subagent-start.sh's missing-file guard
# would drop them, so each case rewrites active_plan to a real tmp file while
# keeping the fixture's plans/bindings registry shape.

@test "shim resolution: explicit binding for this session wins over other plans" {
	local plan_a="$BATS_TEST_TMPDIR/plan-a.md"
	local plan_b="$BATS_TEST_TMPDIR/plan-b.md"
	printf '# Plan A\n' > "$plan_a"
	printf '# Plan B\n' > "$plan_b"

	local fixture="$_TEST_HELPER_DIR/../fixtures/boulder-schemas/two-plan.json"
	local registry
	registry=$(jq --arg a "$plan_a" --arg b "$plan_b" --arg sid "$CLAUDE_SESSION_ID" \
		'.plans["plan-a"].active_plan = $a | .plans["plan-b"].active_plan = $b |
		 .bindings[$sid] = {"plan_name": "plan-a"}' "$fixture")
	write_state "boulder.json" "$registry"

	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "\[ACTIVE PLAN\] Refer to: ${plan_a}"
	! echo "$ctx" | grep -q "${plan_b}"
}

@test "shim resolution: no binding + single registered plan falls back to that plan" {
	local plan_a="$BATS_TEST_TMPDIR/plan-a.md"
	printf '# Plan A\n' > "$plan_a"

	local fixture="$_TEST_HELPER_DIR/../fixtures/boulder-schemas/single-plan.json"
	local registry
	registry=$(jq --arg a "$plan_a" '.plans["plan-a"].active_plan = $a' "$fixture")
	write_state "boulder.json" "$registry"

	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -q "\[ACTIVE PLAN\] Refer to: ${plan_a}"
}

@test "shim resolution: no binding + multiple plans falls back to most-recent started_at" {
	local plan_a="$BATS_TEST_TMPDIR/plan-a.md"
	local plan_b="$BATS_TEST_TMPDIR/plan-b.md"
	printf '# Plan A\n' > "$plan_a"
	printf '# Plan B\n' > "$plan_b"

	local fixture="$_TEST_HELPER_DIR/../fixtures/boulder-schemas/two-plan.json"
	local registry
	registry=$(jq --arg a "$plan_a" --arg b "$plan_b" \
		'.plans["plan-a"].active_plan = $a | .plans["plan-b"].active_plan = $b' "$fixture")
	write_state "boulder.json" "$registry"

	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	# plan-b has the later started_at (2026-03-01 vs 2026-02-01)
	echo "$ctx" | grep -q "\[ACTIVE PLAN\] Refer to: ${plan_b}"
	! echo "$ctx" | grep -q "${plan_a}"
}

@test "shim resolution: empty registry injects no plan context" {
	write_state "boulder.json" '{"plans":{},"bindings":{}}'

	run_hook "subagent-start.sh" "$EXPLORE_PAYLOAD"
	assert_success
	local ctx
	ctx=$(get_context)
	! echo "$ctx" | grep -q "\[ACTIVE PLAN\]"
	! echo "$ctx" | grep -q "\[NOTEPAD AVAILABLE\]"
}

# ─── q. Model capture into subagent-models.json ──────────────────────────────

@test "model capture: executor agent_type resolves to Sonnet" {
	run_hook "subagent-start.sh" "$EXECUTOR_PAYLOAD"
	assert_success
	local model
	model=$(read_state "subagent-models.json" | jq -r '."agent-abc123".model')
	assert [ "$model" = "Sonnet" ]
	local type
	type=$(read_state "subagent-models.json" | jq -r '."agent-abc123".agent_type')
	assert [ "$type" = "oh-my-claudeagent:executor" ]
}

@test "model capture: sisyphus agent_type resolves to Opus 4.8" {
	run_hook "subagent-start.sh" "$SISYPHUS_PAYLOAD"
	assert_success
	local model
	model=$(read_state "subagent-models.json" | jq -r '."agent-abc123".model')
	assert [ "$model" = "Opus 4.8" ]
}

@test "model capture: non-OMCA agent_type stores empty model" {
	local payload='{"session_id":"test","hook_event_name":"SubagentStart","agent_id":"agent-xyz","agent_type":"general-purpose"}'
	run_hook "subagent-start.sh" "$payload"
	assert_success
	local model
	model=$(read_state "subagent-models.json" | jq -r '."agent-xyz".model')
	assert [ "$model" = "" ]
}

@test "model capture: empty agent_id skips write" {
	local payload='{"session_id":"test","hook_event_name":"SubagentStart","agent_type":"oh-my-claudeagent:explore"}'
	run_hook "subagent-start.sh" "$payload"
	assert_success
	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/subagent-models.json" ]
}
