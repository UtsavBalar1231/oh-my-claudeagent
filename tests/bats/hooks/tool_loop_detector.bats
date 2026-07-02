#!/usr/bin/env bats
load '../test_helper'

# ─── tool-loop-detector.sh ────────────────────────────────────────────────────

@test "tool-loop-detector: 3 identical calls emit advisory only on the third" {
	local payload
	payload='{"tool_name":"Bash","tool_input":{"command":"ls foo"}}'

	run_hook "tool-loop-detector.sh" "$payload"
	assert_success
	assert_output ""

	run_hook "tool-loop-detector.sh" "$payload"
	assert_success
	assert_output ""

	run_hook "tool-loop-detector.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
	echo "$ctx" | grep -qi "loop signal"
}

@test "tool-loop-detector: differing args mid-streak resets the count" {
	local same='{"tool_name":"Bash","tool_input":{"command":"ls foo"}}'
	local different='{"tool_name":"Bash","tool_input":{"command":"ls bar"}}'

	run_hook "tool-loop-detector.sh" "$same"        # count 1
	assert_output ""
	run_hook "tool-loop-detector.sh" "$same"        # count 2
	assert_output ""
	run_hook "tool-loop-detector.sh" "$different"   # reset, count 1
	assert_output ""
	run_hook "tool-loop-detector.sh" "$same"        # reset, count 1
	assert_output ""
	run_hook "tool-loop-detector.sh" "$same"        # count 2
	assert_output ""
	run_hook "tool-loop-detector.sh" "$same"        # count 3 -> fires
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
	echo "$ctx" | grep -qi "loop signal"
}

@test "tool-loop-detector: same tool_input but different tool name is a different signature" {
	local bash_call='{"tool_name":"Bash","tool_input":{"command":"ls foo"}}'
	local edit_call='{"tool_name":"Edit","tool_input":{"command":"ls foo"}}'

	run_hook "tool-loop-detector.sh" "$bash_call"   # count 1
	assert_output ""
	run_hook "tool-loop-detector.sh" "$bash_call"   # count 2
	assert_output ""
	run_hook "tool-loop-detector.sh" "$edit_call"   # different tool -> reset, count 1
	assert_success
	assert_output ""
}

@test "tool-loop-detector: OMCA_DISABLED_HOOKS bypasses detection entirely" {
	local payload
	payload='{"tool_name":"Bash","tool_input":{"command":"ls foo"}}'

	OMCA_DISABLED_HOOKS="tool-loop-detector" run_hook "tool-loop-detector.sh" "$payload"
	assert_success
	assert_output ""
	OMCA_DISABLED_HOOKS="tool-loop-detector" run_hook "tool-loop-detector.sh" "$payload"
	assert_success
	assert_output ""
	OMCA_DISABLED_HOOKS="tool-loop-detector" run_hook "tool-loop-detector.sh" "$payload"
	assert_success
	assert_output ""
}

@test "tool-loop-detector: malformed payload exits 0 silently" {
	run_hook "tool-loop-detector.sh" "not json{{{"
	assert_success
	assert_output ""
}
