#!/usr/bin/env bats
# hooks/hooks.json: structural coverage that validate-plugin.sh's registration checks
# alone would not catch.

load '../test_helper'

HOOKS_JSON="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)/hooks/hooks.json"

@test "hooks.json: is valid JSON" {
	run jq . "$HOOKS_JSON"
	assert_success
}

@test "hooks.json: delegation-reminder.sh is not registered" {
	run jq -e '
		[.hooks[][]?.hooks[]? | (.command // "") | select(test("delegation-reminder\\.sh\"?$"))] | length == 0
	' "$HOOKS_JSON"
	assert_success
}

# validate-plugin.sh keeps a stdout-shape helper for command-form hook scripts, of which
# none are registered today. The script is sourced with VALIDATE_PLUGIN_SOURCE_ONLY=1 so the
# helper can be driven against fixture scripts without running any check.
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
