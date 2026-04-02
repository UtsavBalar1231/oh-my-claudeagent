#!/usr/bin/env bats
load '../test_helper'

# permission-filter.sh — tests covering each `if`-guarded PermissionRequest handler.
# The `if` dispatch is platform-level; these tests verify the script's output directly.

# ── rm -rf: denied ────────────────────────────────────────────────────────────

@test "if Bash(rm *): rm -rf /tmp/build is denied" {
	local fixture="$CLAUDE_PLUGIN_ROOT/tests/fixtures/hooks/permissionrequest-rm-rf.json"
	run_hook_file "permission-filter.sh" "$fixture"
	assert_success
	assert_output --partial '"deny"'
}

@test "if Bash(rm *): decision message mentions destructive operation" {
	local fixture="$CLAUDE_PLUGIN_ROOT/tests/fixtures/hooks/permissionrequest-rm-rf.json"
	run_hook_file "permission-filter.sh" "$fixture"
	assert_success
	assert_output --partial 'Destructive rm'
}

@test "if Bash(rm *): rm -r variant is also denied" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"rm -r /tmp/old"}}'
	assert_success
	assert_output --partial '"deny"'
}

@test "if Bash(rm *): sudo rm -rf is denied" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"sudo rm -rf /var/cache"}}'
	assert_success
	assert_output --partial '"deny"'
}

# ── npm: allowed ──────────────────────────────────────────────────────────────

@test "if Bash(npm *): npm test is allowed" {
	local fixture="$CLAUDE_PLUGIN_ROOT/tests/fixtures/hooks/permissionrequest-npm-test.json"
	run_hook_file "permission-filter.sh" "$fixture"
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(npm *): npm install is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm install express"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(npm *): npm run build is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm run build"}}'
	assert_success
	assert_output --partial '"allow"'
}

# ── jq: allowed (with rawfile exception) ──────────────────────────────────────

@test "if Bash(jq *): jq query is allowed" {
	local fixture="$CLAUDE_PLUGIN_ROOT/tests/fixtures/hooks/permissionrequest-jq.json"
	run_hook_file "permission-filter.sh" "$fixture"
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(jq *): jq -r is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"jq -r .name package.json"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(jq *): jq --rawfile produces no decision (falls through)" {
	# --rawfile can read arbitrary files; permission-filter falls through
	# so the platform asks the user instead of auto-allowing
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"jq --rawfile data file.txt . input.json"}}'
	assert_success
	assert_output ""
}

# ── uv: allowed ───────────────────────────────────────────────────────────────

@test "if Bash(uv *): uv run python script.py is allowed" {
	local fixture="$CLAUDE_PLUGIN_ROOT/tests/fixtures/hooks/permissionrequest-uv.json"
	run_hook_file "permission-filter.sh" "$fixture"
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(uv *): uv run --project servers ruff check is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"uv run --project servers ruff check servers/"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(uv *): uv sync is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"uv sync"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(uv *): uv sync --frozen is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"uv sync --frozen"}}'
	assert_success
	assert_output --partial '"allow"'
}

# ── rmdir edge case ───────────────────────────────────────────────────────────
# The script regex requires bare "rm" followed by flags, so "rmdir" does not
# match and the script exits 0 with no output (falls through to user decision).
# Whether platform glob "Bash(rm *)" dispatches for rmdir is not testable here.

@test "rmdir does not match the rm -rf regex: script produces no decision" {
	local fixture="$CLAUDE_PLUGIN_ROOT/tests/fixtures/hooks/permissionrequest-rmdir.json"
	run_hook_file "permission-filter.sh" "$fixture"
	assert_success
	assert_output ""
}

@test "rmdir inline: exits 0 with no output (script has no opinion)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"rmdir foo"}}'
	assert_success
	assert_output ""
}
