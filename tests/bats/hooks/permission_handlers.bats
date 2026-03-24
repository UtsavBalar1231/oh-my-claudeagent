#!/usr/bin/env bats
load '../test_helper'

# ── permission-filter.sh tests ────────────────────────────────────────────────

@test "permission-filter: npm install is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm install express"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "permission-filter: uv run is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"uv run --project servers ruff check servers/"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "permission-filter: rm -rf is denied" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}'
	assert_success
	assert_output --partial '"deny"'
}

@test "permission-filter: unknown command produces no output (no opinion)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"python3 script.py"}}'
	assert_success
	assert_output ""
}

@test "permission-filter: jq is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"jq . file.json"}}'
	assert_success
	assert_output --partial '"allow"'
}

# ── plan-mode-handler.sh tests ────────────────────────────────────────────────

@test "plan-mode-handler: ExitPlanMode is approved with acceptEdits mode" {
	local fixture="$CLAUDE_PLUGIN_ROOT/tests/fixtures/hooks/permissionrequest-exitplanmode.json"
	run_hook_file "plan-mode-handler.sh" "$fixture"
	assert_success
	assert_output --partial '"allow"'
	assert_output --partial 'acceptEdits'
}
