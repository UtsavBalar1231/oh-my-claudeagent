#!/usr/bin/env bats
load '../test_helper'

# ─── tool-loop-detector.sh on PostToolBatch ───────────────────────────────────

batch_payload() {
	printf '{"hook_event_name":"PostToolBatch","tool_calls":%s}' "$1"
}

READ_A='[{"tool_name":"Read","tool_input":{"file_path":"/a"},"tool_use_id":"t1","tool_response":"1\tone"}]'
READ_B='[{"tool_name":"Read","tool_input":{"file_path":"/b"},"tool_use_id":"t2","tool_response":"1\ttwo"}]'
READ_AB='[{"tool_name":"Read","tool_input":{"file_path":"/a"}},{"tool_name":"Read","tool_input":{"file_path":"/b"}}]'

@test "tool-loop-batch: 3 identical batches emit the advisory only on the third" {
	local payload
	payload=$(batch_payload "$READ_AB")

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
	echo "$ctx" | rg -qi "loop signal"
	echo "$output" | jq -e '.hookSpecificOutput.hookEventName == "PostToolBatch"'

	# The 4th identical batch must stay silent — one nudge per streak.
	run_hook "tool-loop-detector.sh" "$payload"
	assert_success
	assert_output ""
}

@test "tool-loop-batch: a differing batch mid-streak resets the count" {
	local same different
	same=$(batch_payload "$READ_A")
	different=$(batch_payload "$READ_B")

	run_hook "tool-loop-detector.sh" "$same"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$same"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$different"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$same"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$same"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$same"
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
	echo "$ctx" | rg -qi "loop signal"
}

@test "tool-loop-batch: a batch differing only in membership is a different signature" {
	local one two
	one=$(batch_payload "$READ_A")
	two=$(batch_payload "$READ_AB")

	run_hook "tool-loop-detector.sh" "$one"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$one"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$two"
	assert_success
	assert_output ""
	[ "$(read_state tool-loop-window.json | jq -r '.count')" = "1" ]
}

@test "tool-loop-batch: identical tool_input under a different tool name is a different signature" {
	local bash_call edit_call
	bash_call=$(batch_payload '[{"tool_name":"Bash","tool_input":{"command":"ls foo"}}]')
	edit_call=$(batch_payload '[{"tool_name":"Edit","tool_input":{"command":"ls foo"}}]')

	run_hook "tool-loop-detector.sh" "$bash_call"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$bash_call"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$edit_call"
	assert_success
	assert_output ""
	[ "$(read_state tool-loop-window.json | jq -r '.count')" = "1" ]
}

@test "tool-loop-batch: differing tool_response does not break a streak" {
	local first second
	first=$(batch_payload '[{"tool_name":"Bash","tool_input":{"command":"ls"},"tool_response":"a\n"}]')
	second=$(batch_payload '[{"tool_name":"Bash","tool_input":{"command":"ls"},"tool_response":"b\n"}]')

	run_hook "tool-loop-detector.sh" "$first"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$second"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$first"
	local ctx
	ctx=$(get_context)
	echo "$ctx" | rg -qi "loop signal"
}

@test "tool-loop-batch: a new prompt_id resets the streak" {
	local turn_one turn_two
	turn_one='{"hook_event_name":"PostToolBatch","prompt_id":"p1","tool_calls":'"$READ_A"'}'
	turn_two='{"hook_event_name":"PostToolBatch","prompt_id":"p2","tool_calls":'"$READ_A"'}'

	run_hook "tool-loop-detector.sh" "$turn_one"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$turn_one"
	assert_output ""
	run_hook "tool-loop-detector.sh" "$turn_two"
	assert_success
	assert_output ""
	[ "$(read_state tool-loop-window.json | jq -r '.count')" = "1" ]
}

@test "tool-loop-batch: an empty batch writes no state and stays silent" {
	run_hook "tool-loop-detector.sh" '{"hook_event_name":"PostToolBatch","tool_calls":[]}'
	assert_success
	assert_output ""
	[ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/tool-loop-window.json" ]
}

@test "tool-loop-batch: OMCA_DISABLED_HOOKS bypasses detection entirely" {
	local payload
	payload=$(batch_payload "$READ_A")

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

@test "tool-loop-batch: malformed payload exits 0 silently" {
	run_hook "tool-loop-detector.sh" "not json{{{"
	assert_success
	assert_output ""
}
