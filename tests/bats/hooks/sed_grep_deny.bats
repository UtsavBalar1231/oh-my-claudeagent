#!/usr/bin/env bats
load '../test_helper'

# sed-grep-deny.sh — PreToolUse Bash hook that blocks sed -n and grep -n

# ── sed -n: denied ────────────────────────────────────────────────────────────

@test "sed -n '1,5p' file is denied" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"sed -n '\''1,5p'\'' file.txt"}}'
	assert_failure 2
}

@test "sed -ne 'expr' file is denied (clustered short flags)" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"sed -ne '\''s/x/y/p'\'' file.txt"}}'
	assert_failure 2
}

@test "sed -n stderr message is exact" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"sed -n '\''1p'\'' file.txt"}}'
	assert_failure 2
	assert_output --partial '`sed -n` and `grep -n` are denied.'
	assert_output --partial 'Use the Grep tool, Read with offset/limit, or ast_search for structural matches.'
}

# ── grep -n: denied ───────────────────────────────────────────────────────────

@test "grep -n pattern file is denied" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -n pattern file.txt"}}'
	assert_failure 2
}

@test "grep -nA 3 pattern file is denied (clustered flags)" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -nA 3 pattern file.txt"}}'
	assert_failure 2
}

@test "grep -nB 3 pattern file is denied (clustered flags)" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -nB 3 pattern file.txt"}}'
	assert_failure 2
}

@test "grep -n stderr message is exact" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -n foo bar.txt"}}'
	assert_failure 2
	assert_output --partial '`sed -n` and `grep -n` are denied.'
	assert_output --partial 'Use the Grep tool, Read with offset/limit, or ast_search for structural matches.'
}

# ── grep without -n: allowed ──────────────────────────────────────────────────

@test "grep pattern file (no -n) exits 0" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep foo file.txt"}}'
	assert_success
	assert_output '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
}

@test "grep -r foo dir (no -n) exits 0" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -r foo /some/dir"}}'
	assert_success
	assert_output '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
}

@test "grep -c foo file (no -n) exits 0" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -c foo file.txt"}}'
	assert_success
	assert_output '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
}

# ── sed without -n: allowed ───────────────────────────────────────────────────

@test "sed -i 's/x/y/' file (in-place, no -n) exits 0" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"sed -i '\''s/x/y/'\'' file.txt"}}'
	assert_success
	assert_output '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
}

@test "sed -e 's/x/y/' file (expression, no -n) exits 0" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"sed -e '\''s/x/y/'\'' file.txt"}}'
	assert_success
	assert_output '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
}

# ── unrelated commands: allowed ───────────────────────────────────────────────

@test "find . -name '*.foo' exits 0 (unrelated command)" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"find . -name '\''*.foo'\''"}}'
	assert_success
	assert_output '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
}

@test "empty command exits 0" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":""}}'
	assert_success
	assert_output ""
}

@test "missing command field exits 0" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{}}'
	assert_success
	assert_output ""
}
