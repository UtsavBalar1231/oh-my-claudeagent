#!/usr/bin/env bats
load '../test_helper'

# ─── e. edit-error-recovery.sh ───────────────────────────────────────────────

@test "edit-error-recovery: file not found error produces recovery guidance" {
	local payload
	payload='{"tool_name":"Edit","tool_input":{"file_path":"/tmp/foo.sh"},"error":"old_string not found in file"}'
	run_hook "edit-error-recovery.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
}

@test "edit-error-recovery: not unique error mentions surrounding context" {
	local payload
	payload='{"tool_name":"Edit","tool_input":{"file_path":"/tmp/foo.sh"},"error":"old_string is not unique in the file"}'
	run_hook "edit-error-recovery.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
	# Should mention uniqueness or context
	echo "$ctx" | grep -qi "unique"
}

# ─── f. delegate-retry.sh ────────────────────────────────────────────────────

@test "delegate-retry: unknown agent error produces oracle/escalation suggestion" {
	local payload
	payload='{"tool_name":"Task","tool_input":{"subagent_type":"oh-my-claudeagent:explore"},"error":"Agent failed: timeout"}'
	run_hook "delegate-retry.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
}

@test "delegate-retry: nesting depth violation produces NESTING LIMIT message" {
	local payload
	payload='{"tool_name":"Agent","tool_input":{"subagent_type":"oh-my-claudeagent:executor"},"error":"No such tool available: Agent"}'
	run_hook "delegate-retry.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -qi "nesting"
}

# ─── g. bash-error-recovery.sh ───────────────────────────────────────────────

@test "bash-error-recovery: command not found error produces recovery advice" {
	local payload
	payload='{"tool_name":"Bash","tool_input":{"command":"foobar --version"},"error":"foobar: command not found"}'
	run_hook "bash-error-recovery.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
}

@test "bash-error-recovery: test failure error produces recovery advice" {
	local payload
	payload='{"tool_name":"Bash","tool_input":{"command":"just test"},"error":"FAIL: 3 tests failed. AssertionError: expected true"}'
	run_hook "bash-error-recovery.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
}

@test "bash-error-recovery: unknown bash error exits 0 with no output (catch-all defers)" {
	local payload
	payload='{"tool_name":"Bash","tool_input":{"command":"some-script.sh"},"error":"some completely unknown error"}'
	run_hook "bash-error-recovery.sh" "$payload"
	assert_success
	assert_output ""
}

# ─── h. read-error-recovery.sh ───────────────────────────────────────────────

@test "read-error-recovery: file not found produces recovery advice" {
	local payload
	payload='{"tool_name":"Read","tool_input":{"file_path":"/nonexistent/file.txt"},"error":"No such file or directory: /nonexistent/file.txt"}'
	run_hook "read-error-recovery.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
}

@test "read-error-recovery: directory path error produces recovery advice" {
	local payload
	payload='{"tool_name":"Read","tool_input":{"file_path":"/tmp"},"error":"Path is a directory, not a file"}'
	run_hook "read-error-recovery.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
}

# ─── i. json-error-recovery.sh (catch-all) ───────────────────────────────────

@test "json-error-recovery: JSON parse error in MCP tool produces recovery guidance" {
	local payload
	payload='{"tool_name":"mcp__omca__ast_search","error":"invalid JSON: Unexpected token } at position 42"}'
	run_hook "json-error-recovery.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
	echo "$ctx" | grep -qi "json"
}

@test "json-error-recovery: Bash tool exits 0 silently (deferred to bash-error-recovery)" {
	local payload
	payload='{"tool_name":"Bash","error":"invalid JSON in output"}'
	run_hook "json-error-recovery.sh" "$payload"
	assert_success
	assert_output ""
}
