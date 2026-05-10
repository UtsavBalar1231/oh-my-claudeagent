#!/usr/bin/env bats
# Structural migration contract for plan-checkbox-verify → mcp_tool.
# Behavioral coverage (Write/Edit input branching) lives in
# servers/tests/test_validate_plan_write.py.

load '../test_helper'

# (a) Old shell script must not exist — no dead code after migration

@test "plan-checkbox-verify: shell script deleted after mcp_tool migration" {
	run test -f "${BATS_TEST_DIRNAME}/../../../scripts/plan-checkbox-verify.sh"
	[ "$status" -ne 0 ]
}

# (b) hooks.json must have an mcp_tool entry for validate_plan_write

@test "plan-checkbox-verify: hooks.json contains mcp_tool entry for validate_plan_write" {
	local hooks_json="${BATS_TEST_DIRNAME}/../../../hooks/hooks.json"
	run jq -e '
		.hooks.PreToolUse[]
		| select(.hooks[].type == "mcp_tool")
		| .hooks[]
		| select(.tool == "validate_plan_write")
	' "$hooks_json"
	assert_success
}

# (c) mcp_tool entry targets the omca server

@test "plan-checkbox-verify: mcp_tool entry uses omca server" {
	local hooks_json="${BATS_TEST_DIRNAME}/../../../hooks/hooks.json"
	run jq -e '
		.hooks.PreToolUse[]
		| select(.hooks[].type == "mcp_tool")
		| .hooks[]
		| select(.tool == "validate_plan_write" and .server == "omca")
	' "$hooks_json"
	assert_success
}

# (d) mcp_tool entry matcher covers both Write and Edit

@test "plan-checkbox-verify: mcp_tool matcher covers Write and Edit" {
	local hooks_json="${BATS_TEST_DIRNAME}/../../../hooks/hooks.json"
	run jq -r '
		.hooks.PreToolUse[]
		| select(.hooks[].type == "mcp_tool")
		| select(.hooks[].tool == "validate_plan_write")
		| .matcher
	' "$hooks_json"
	assert_success
	echo "$output" | grep -q "Write"
	echo "$output" | grep -q "Edit"
}

# (e) Old command entry for plan-checkbox-verify.sh must be absent

@test "plan-checkbox-verify: no command hook referencing plan-checkbox-verify.sh remains" {
	local hooks_json="${BATS_TEST_DIRNAME}/../../../hooks/hooks.json"
	run jq -e '
		.hooks.PreToolUse[]
		| .hooks[]
		| select(.type == "command" and (.command | test("plan-checkbox-verify")))
	' "$hooks_json"
	[ "$status" -ne 0 ]
}

# (f) input substitutions include tool_name, file_path, content, new_string

@test "plan-checkbox-verify: mcp_tool input has required substitution fields" {
	local hooks_json="${BATS_TEST_DIRNAME}/../../../hooks/hooks.json"
	local input
	input=$(jq -r '
		.hooks.PreToolUse[]
		| select(.hooks[].tool == "validate_plan_write")
		| .hooks[]
		| select(.tool == "validate_plan_write")
		| .input
	' "$hooks_json")
	echo "$input" | jq -e '.tool_name' > /dev/null
	echo "$input" | jq -e '.file_path' > /dev/null
	echo "$input" | jq -e '.content' > /dev/null
	echo "$input" | jq -e '.new_string' > /dev/null
}
