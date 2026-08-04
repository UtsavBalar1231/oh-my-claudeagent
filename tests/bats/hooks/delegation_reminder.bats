#!/usr/bin/env bats
# Behavioral tests for delegation-reminder.sh: one-shot nudge when the main
# session runs direct work tools repeatedly without delegating.

load '../test_helper'

# ── Threshold behavior ────────────────────────────────────────────────────────

@test "first direct call increments counter, no reminder" {
	run_hook "delegation-reminder.sh" '{"tool_name":"Write"}'
	assert_success
	assert_output ""
	[ "$(jq -r '.direct_calls' "$CLAUDE_PROJECT_ROOT/.omca/state/delegation-counter.json")" = "1" ]
}

@test "second direct call increments counter, no reminder" {
	run_hook "delegation-reminder.sh" '{"tool_name":"Write"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Edit"}'
	assert_success
	assert_output ""
	[ "$(jq -r '.direct_calls' "$CLAUDE_PROJECT_ROOT/.omca/state/delegation-counter.json")" = "2" ]
}

@test "third direct call triggers exactly one reminder" {
	run_hook "delegation-reminder.sh" '{"tool_name":"Write"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Edit"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Bash"}'
	assert_success
	local ctx
	ctx=$(get_context)
	[[ "$ctx" == *"DELEGATION REMINDER"* ]]
	[[ "$ctx" == *"oh-my-claudeagent:executor"* ]]
	[ "$(jq -r '.silenced' "$CLAUDE_PROJECT_ROOT/.omca/state/delegation-counter.json")" = "true" ]
}

@test "fourth direct call produces nothing after silencing" {
	run_hook "delegation-reminder.sh" '{"tool_name":"Write"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Edit"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Bash"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Write"}'
	assert_success
	assert_output ""
}

# ── Main-session detection via .agent_id ──────────────────────────────────────

@test "payload with agent_id set (inside a subagent) never increments or triggers" {
	run_hook "delegation-reminder.sh" '{"tool_name":"Write","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Edit","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Bash","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor"}'
	assert_success
	assert_output ""
	[ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/delegation-counter.json" ]
}

# Regression pin: the base hook payload has no top-level subagent_type, so a
# fixture built around that field would let this nudge fire inside a leaf worker
# and tell an executor to delegate — which executors are forbidden to do.
@test "REAL subagent payload never nudges a leaf worker to delegate" {
	local p='{"session_id":"11111111-2222-3333-4444-555555555555","transcript_path":"/tmp/t.jsonl","cwd":"/tmp","prompt_id":"p1","permission_mode":"default","agent_id":"agt_abc123","agent_type":"oh-my-claudeagent:executor","effort":"medium","tool_name":"Write"}'
	run_hook "delegation-reminder.sh" "$p"
	run_hook "delegation-reminder.sh" "$p"
	run_hook "delegation-reminder.sh" "$p"
	assert_success
	assert_output ""
	[ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/delegation-counter.json" ]
}

# ── Agent-call reset/silence branch ────────────────────────────────────────────

@test "tool_name Agent resets and silences, no output" {
	run_hook "delegation-reminder.sh" '{"tool_name":"Write"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Edit"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Agent"}'
	assert_success
	assert_output ""
	[ "$(jq -r '.direct_calls' "$CLAUDE_PROJECT_ROOT/.omca/state/delegation-counter.json")" = "0" ]
	[ "$(jq -r '.silenced' "$CLAUDE_PROJECT_ROOT/.omca/state/delegation-counter.json")" = "true" ]
}

@test "after Agent reset, subsequent direct calls do not re-trigger (silenced stays true)" {
	run_hook "delegation-reminder.sh" '{"tool_name":"Write"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Edit"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Agent"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Write"}'
	assert_success
	assert_output ""
}

# ── Kill switch ─────────────────────────────────────────────────────────────

@test "kill switch OMCA_DISABLED_HOOKS suppresses the hook entirely" {
	export OMCA_DISABLED_HOOKS="delegation-reminder"
	run_hook "delegation-reminder.sh" '{"tool_name":"Write"}'
	assert_success
	assert_output ""
	[ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/delegation-counter.json" ]
	unset OMCA_DISABLED_HOOKS
}

# ── Malformed payload ───────────────────────────────────────────────────────

@test "malformed payload exits 0 without crashing" {
	run bash "$CLAUDE_PLUGIN_ROOT/scripts/delegation-reminder.sh" <<< 'not json'
	assert_success
}
