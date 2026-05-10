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

# ── npm: safe subcommands allowed; install/publish/exec fall through ──────────

@test "if Bash(npm *): npm test is allowed" {
	local fixture="$CLAUDE_PLUGIN_ROOT/tests/fixtures/hooks/permissionrequest-npm-test.json"
	run_hook_file "permission-filter.sh" "$fixture"
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(npm *): npm run build is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm run build"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(npm *): npm run test is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm run test"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(npm *): npm ci is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm ci"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(npm *): npm list is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm list"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(npm *): npm view react is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm view react"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(npm *): npm install <pkg> falls through (no decision)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm install express"}}'
	assert_success
	assert_output ""
}

@test "if Bash(npm *): npm install (bare) falls through (no decision)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm install"}}'
	assert_success
	assert_output ""
}

@test "if Bash(npm *): npm i falls through (no decision)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm i lodash"}}'
	assert_success
	assert_output ""
}

@test "if Bash(npm *): npm publish falls through (no decision)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm publish"}}'
	assert_success
	assert_output ""
}

@test "if Bash(npm *): npm exec falls through (no decision)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"npm exec some-tool"}}'
	assert_success
	assert_output ""
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

# ── sudo: deny on rm -rf; fall-through otherwise ─────────────────────────────
# The `if: "Bash(sudo *)"` hook entry ensures sudo commands reach this script.
# sudo rm -rf is blocked by the rm-rf regex (line 16 of permission-filter.sh).
# Other sudo commands produce no output (fall through to user decision).

@test "if Bash(sudo *): sudo rm -rf / is denied" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"sudo rm -rf /"}}'
	assert_success
	assert_output --partial '"deny"'
}

@test "if Bash(sudo *): sudo rm -rf /var/cache is denied" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"sudo rm -rf /var/cache"}}'
	assert_success
	assert_output --partial '"deny"'
}

@test "if Bash(sudo *): sudo apt-get install produces no decision (falls through)" {
	# sudo commands that are not rm -rf have no auto-allow; platform decides
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"sudo apt-get install build-essential"}}'
	assert_success
	assert_output ""
}

# ── bun: safe subcommands allowed; install <pkg> falls through ────────────────
# Policy: auto-allow bun run/test; bun install <pkg> falls through to user.

@test "if Bash(bun *): bun run build is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"bun run build"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(bun *): bun test is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"bun test"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(bun *): bun ci is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"bun ci"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(bun *): bun install <package> falls through (no decision)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"bun install some-package"}}'
	assert_success
	assert_output ""
}

@test "if Bash(bun *): bun install (bare) falls through (no decision)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"bun install"}}'
	assert_success
	assert_output ""
}

# ── yarn: safe subcommands allowed; add <pkg> falls through ───────────────────

@test "if Bash(yarn *): yarn run build is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"yarn run build"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(yarn *): yarn test is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"yarn test"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(yarn *): yarn ci is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"yarn ci"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(yarn *): yarn install falls through (no decision)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"yarn install"}}'
	assert_success
	assert_output ""
}

@test "if Bash(yarn *): yarn add <package> falls through (no decision)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"yarn add lodash"}}'
	assert_success
	assert_output ""
}

# ── pnpm: safe subcommands allowed; install falls through ────────────────────

@test "if Bash(pnpm *): pnpm run test is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"pnpm run test"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(pnpm *): pnpm test is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"pnpm test"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(pnpm *): pnpm ci is allowed" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"pnpm ci"}}'
	assert_success
	assert_output --partial '"allow"'
}

@test "if Bash(pnpm *): pnpm install falls through (no decision)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"pnpm install"}}'
	assert_success
	assert_output ""
}

@test "if Bash(pnpm *): pnpm add <package> falls through (no decision)" {
	run_hook "permission-filter.sh" '{"tool_name":"Bash","tool_input":{"command":"pnpm add express"}}'
	assert_success
	assert_output ""
}
