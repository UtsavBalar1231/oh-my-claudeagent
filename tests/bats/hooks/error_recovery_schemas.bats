#!/usr/bin/env bats
load '../test_helper'

# Verifies each recovery script reads canonical PostToolUseFailure `.error`
# (not phantom `.tool_error` / `.tool_result.error`).
# Each test: canonical fixture → advice produced; phantom fixture → silent.

# ─── bash-error-recovery.sh ──────────────────────────────────────────────────

@test "bash-error-recovery: reads error from canonical .error field" {
	local payload
	payload='{"tool_name":"Bash","tool_input":{"command":"foobar"},"error":"foobar: command not found"}'
	run_hook "bash-error-recovery.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
	echo "$ctx" | grep -qi "command not found\|PATH\|installed"
}

@test "bash-error-recovery: phantom .tool_error field produces no advice (fallback removed)" {
	# No top-level .error — only the phantom field that was formerly in the fallback chain.
	local payload
	payload='{"tool_name":"Bash","tool_input":{"command":"foobar"},"tool_error":"foobar: command not found"}'
	run_hook "bash-error-recovery.sh" "$payload"
	assert_success
	# Script exits 0 with no output — unknown/missing error defers to catch-all.
	assert_output ""
}

# ─── read-error-recovery.sh ──────────────────────────────────────────────────

@test "read-error-recovery: reads error from canonical .error field" {
	local payload
	payload='{"tool_name":"Read","tool_input":{"file_path":"/no/such/file.txt"},"error":"No such file or directory: /no/such/file.txt"}'
	run_hook "read-error-recovery.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
	echo "$ctx" | grep -qi "not found\|Glob\|search"
}

@test "read-error-recovery: phantom .tool_error field produces no advice (fallback removed)" {
	local payload
	payload='{"tool_name":"Read","tool_input":{"file_path":"/no/such/file.txt"},"tool_error":"ENOENT: no such file or directory"}'
	run_hook "read-error-recovery.sh" "$payload"
	assert_success
	assert_output ""
}

# ─── edit-error-recovery.sh ──────────────────────────────────────────────────

@test "edit-error-recovery: reads error from canonical .error field" {
	local payload
	payload='{"tool_name":"Edit","tool_input":{"file_path":"/tmp/foo.sh"},"error":"old_string not found in file"}'
	run_hook "edit-error-recovery.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
	echo "$ctx" | grep -qi "re-read\|current contents\|not found"
}

@test "edit-error-recovery: phantom .tool_result.error field ignored — falls back to generic advice" {
	# No top-level .error → script defaults to "Unknown error" fallback text,
	# which triggers the generic "Edit failed. Re-read..." branch.
	local payload
	payload='{"tool_name":"Edit","tool_input":{"file_path":"/tmp/foo.sh"},"tool_result":{"error":"old_string not found in file"}}'
	run_hook "edit-error-recovery.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	# Generic fallback advice must still be emitted (ERROR_MSG = "Unknown error").
	[ -n "$ctx" ]
	echo "$ctx" | grep -qi "re-read\|verify current contents"
}

# ─── delegate-retry.sh ───────────────────────────────────────────────────────

@test "delegate-retry: reads error from canonical .error field" {
	local payload
	payload='{"tool_name":"Agent","tool_input":{"subagent_type":"oh-my-claudeagent:executor"},"error":"Agent failed: rate limit exceeded"}'
	run_hook "delegate-retry.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
	echo "$ctx" | grep -qi "RETRYABLE\|transient\|rate"
}

@test "delegate-retry: phantom .tool_result.error field ignored — falls back to generic advice" {
	# No top-level .error → ERROR_MSG = "Unknown error" → deterministic branch.
	local payload
	payload='{"tool_name":"Agent","tool_input":{"subagent_type":"oh-my-claudeagent:executor"},"tool_result":{"error":"Agent failed: some error"}}'
	run_hook "delegate-retry.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
	# Generic delegate-retry output, not a nesting-limit or transient message.
	echo "$ctx" | grep -qi "DELEGATE RETRY\|oracle\|different approach"
}

# ─── json-error-recovery.sh ──────────────────────────────────────────────────

@test "json-error-recovery: reads error from canonical .error field" {
	local payload
	payload='{"tool_name":"mcp__omca__ast_search","error":"invalid JSON: Unexpected token } at position 99"}'
	run_hook "json-error-recovery.sh" "$payload"
	assert_success
	local ctx
	ctx=$(get_context)
	[ -n "$ctx" ]
	echo "$ctx" | grep -qi "JSON"
}

@test "json-error-recovery: phantom .tool_result.error field produces no JSON advice" {
	# No top-level .error — error hidden in phantom path — script exits 0 silently.
	local payload
	payload='{"tool_name":"mcp__omca__ast_search","tool_result":{"error":"invalid JSON: Unexpected token }"}}'
	run_hook "json-error-recovery.sh" "$payload"
	assert_success
	assert_output ""
}
