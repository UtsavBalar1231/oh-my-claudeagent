#!/usr/bin/env bats
# hooks/hooks.json: structural coverage for the Phase-4 wiring: asserts the
# three new scripts (plan-continuation-guard.sh, tool-loop-detector.sh,
# delegation-reminder.sh) are registered under the exact event/matcher shapes
# their own headers declare, rather than trusting validate-plugin.sh's
# fixture-replay checks alone to catch a missing or mis-matchered entry.

load '../test_helper'

HOOKS_JSON="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)/hooks/hooks.json"

@test "hooks.json: is valid JSON" {
	run jq . "$HOOKS_JSON"
	assert_success
}

@test "hooks.json: plan-continuation-guard.sh is registered under Stop" {
	run jq -e '
		.hooks.Stop
		| any(.hooks[]?.command | test("plan-continuation-guard\\.sh$"))
	' "$HOOKS_JSON"
	assert_success
}

@test "hooks.json: plan-continuation-guard.sh precedes final-verification-evidence.sh in the Stop array" {
	run jq -r '
		[.hooks.Stop[] | .hooks[]?.command] as $cmds
		| ($cmds | to_entries | map(select(.value | test("plan-continuation-guard\\.sh$")))[0].key) as $guard_idx
		| ($cmds | to_entries | map(select(.value | test("final-verification-evidence\\.sh$")))[0].key) as $fv_idx
		| $guard_idx < $fv_idx
	' "$HOOKS_JSON"
	assert_output "true"
}

@test "hooks.json: tool-loop-detector.sh is registered under PostToolUse with matcher Bash|Edit|Read|Grep|Glob" {
	run jq -e '
		.hooks.PostToolUse
		| any(.matcher == "Bash|Edit|Read|Grep|Glob" and (.hooks[]?.command | test("tool-loop-detector\\.sh$")))
	' "$HOOKS_JSON"
	assert_success
}

@test "hooks.json: delegation-reminder.sh is registered under PostToolUse with matcher Edit|Write|Bash" {
	run jq -e '
		.hooks.PostToolUse
		| any(.matcher == "Edit|Write|Bash" and (.hooks[]?.command | test("delegation-reminder\\.sh$")))
	' "$HOOKS_JSON"
	assert_success
}

@test "hooks.json: delegation-reminder.sh is registered a second time under PostToolUse with matcher Agent" {
	run jq -e '
		.hooks.PostToolUse
		| any(.matcher == "Agent" and (.hooks[]?.command | test("delegation-reminder\\.sh$")))
	' "$HOOKS_JSON"
	assert_success
}

@test "hooks.json: delegation-reminder.sh appears exactly twice total across all PostToolUse entries" {
	run jq -r '
		[.hooks.PostToolUse[] | .hooks[]? | select(.command | test("delegation-reminder\\.sh$"))]
		| length
	' "$HOOKS_JSON"
	assert_output "2"
}
