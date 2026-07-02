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

# ── Main-session detection via .subagent_type ─────────────────────────────────

@test "payload with subagent_type set never increments or triggers" {
	run_hook "delegation-reminder.sh" '{"tool_name":"Write","subagent_type":"oh-my-claudeagent:executor"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Edit","subagent_type":"oh-my-claudeagent:executor"}'
	run_hook "delegation-reminder.sh" '{"tool_name":"Bash","subagent_type":"oh-my-claudeagent:executor"}'
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
