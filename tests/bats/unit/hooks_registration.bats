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
		| any(.hooks[]?.command | test("plan-continuation-guard\\.sh\"?$"))
	' "$HOOKS_JSON"
	assert_success
}

@test "hooks.json: plan-continuation-guard.sh precedes final-verification-evidence.sh in the Stop array" {
	run jq -r '
		[.hooks.Stop[] | .hooks[]?.command] as $cmds
		| ($cmds | to_entries | map(select(.value | test("plan-continuation-guard\\.sh\"?$")))[0].key) as $guard_idx
		| ($cmds | to_entries | map(select(.value | test("final-verification-evidence\\.sh\"?$")))[0].key) as $fv_idx
		| $guard_idx < $fv_idx
	' "$HOOKS_JSON"
	assert_output "true"
}

@test "hooks.json: tool-loop-detector.sh is registered under PostToolBatch with no matcher" {
	run jq -e '
		.hooks.PostToolBatch
		| any((has("matcher") | not) and (.hooks[]?.command | test("tool-loop-detector\\.sh\"?$")))
	' "$HOOKS_JSON"
	assert_success
}

@test "hooks.json: tool-loop-detector.sh is no longer registered under PostToolUse" {
	run jq -e '
		[.hooks.PostToolUse[]?.hooks[]?.command | select(test("tool-loop-detector\\.sh\"?$"))] | length == 0
	' "$HOOKS_JSON"
	assert_success
}

@test "hooks.json: delegation-reminder.sh is registered under PostToolUse with matcher Edit|Write|Bash" {
	run jq -e '
		.hooks.PostToolUse
		| any(.matcher == "Edit|Write|Bash" and (.hooks[]?.command | test("delegation-reminder\\.sh\"?$")))
	' "$HOOKS_JSON"
	assert_success
}

@test "hooks.json: delegation-reminder.sh is registered a second time under PostToolUse with matcher Agent" {
	run jq -e '
		.hooks.PostToolUse
		| any(.matcher == "Agent" and (.hooks[]?.command | test("delegation-reminder\\.sh\"?$")))
	' "$HOOKS_JSON"
	assert_success
}

@test "hooks.json: delegation-reminder.sh appears exactly twice total across all PostToolUse entries" {
	run jq -r '
		[.hooks.PostToolUse[] | .hooks[]? | select(.command | test("delegation-reminder\\.sh\"?$"))]
		| length
	' "$HOOKS_JSON"
	assert_output "2"
}

# validate-plugin.sh --check hooks asserts the stdout shape of every hook script it
# replays. The script is sourced with VALIDATE_PLUGIN_SOURCE_ONLY=1 so the helper can be
# driven against fixture scripts without running any check.
VALIDATE_PLUGIN="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)/scripts/validate-plugin.sh"

run_shape_check() {
	run bash -c '
		VALIDATE_PLUGIN_SOURCE_ONLY=1 source "$0" || exit 9
		printf "{}" >"$1/payload.json"
		run_script_with_payload "fixture" "$2" "$1/payload.json" "$1" "$3"
	' "$VALIDATE_PLUGIN" "$BATS_TEST_TMPDIR" "$1" "${2:-json-optional}"
}

@test "validate-plugin hooks: stdout mixing a JSON object with bare text fails" {
	cat >"$BATS_TEST_TMPDIR/mixed.sh" <<'EOF'
#!/bin/bash
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse"}} advisory text\n'
EOF
	run_shape_check "$BATS_TEST_TMPDIR/mixed.sh"
	assert_failure
	assert_output --partial "FAIL: fixture: stdout mixes a JSON object with bare text"
}

@test "validate-plugin hooks: multi-line pretty-printed JSON stdout fails" {
	cat >"$BATS_TEST_TMPDIR/pretty.sh" <<'EOF'
#!/bin/bash
printf '{\n  "decision": "block"\n}\n'
EOF
	run_shape_check "$BATS_TEST_TMPDIR/pretty.sh"
	assert_failure
	assert_output --partial "FAIL: fixture: stdout starting with { spans multiple lines"
}

@test "validate-plugin hooks: one single-line JSON object and plain text both pass" {
	cat >"$BATS_TEST_TMPDIR/single.sh" <<'EOF'
#!/bin/bash
printf '{"decision":"block","reason":"x"}\n'
EOF
	run_shape_check "$BATS_TEST_TMPDIR/single.sh"
	assert_success
	assert_output --partial "PASS: fixture: stdout shape is plain text or one single-line JSON object"

	cat >"$BATS_TEST_TMPDIR/text.sh" <<'EOF'
#!/bin/bash
printf 'kill switch active\nsecond line\n'
EOF
	run_shape_check "$BATS_TEST_TMPDIR/text.sh" "text-any"
	assert_success
	assert_output --partial "PASS: fixture: stdout shape is plain text or one single-line JSON object"
}
