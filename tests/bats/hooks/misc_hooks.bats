#!/usr/bin/env bats
# Behavioral tests for miscellaneous hook scripts

load '../test_helper'

# ---------------------------------------------------------------------------
# a. write-guard: overwrite warning for existing file
# ---------------------------------------------------------------------------

@test "write-guard: warns when target file already exists" {
	local target="$CLAUDE_PROJECT_ROOT/existing-file.txt"
	printf 'content' > "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "Detected manual write"
}

# ---------------------------------------------------------------------------
# b. write-guard: no warning for non-existent file
# ---------------------------------------------------------------------------

@test "write-guard: no warning when target file does not exist" {
	local target="$CLAUDE_PROJECT_ROOT/new-file-does-not-exist.txt"
	# Ensure the file does not exist
	rm -f "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# c. write-guard: evidence intercept for verification-evidence.json
# ---------------------------------------------------------------------------

@test "write-guard: intercepts writes targeting verification-evidence.json" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/state/verification-evidence.json"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success

	local decision
	decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')
	[ "$decision" = "deny" ]
}

# ---------------------------------------------------------------------------
# d. comment-checker: warns on TODO: implement
# ---------------------------------------------------------------------------

@test "comment-checker: warns when content contains 'TODO: implement'" {
	local content="function foo() {\n  // TODO: implement this\n  return null;\n}"
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "TODO"
}

@test "comment-checker: warns for MultiEdit new_string content" {
	local dirty="function foo() {\n  // TODO: implement this\n  return null;\n}"
	local clean="function bar() {\n  return 1;\n}"
	local payload
	payload=$(jq -nc --arg dirty "$dirty" --arg clean "$clean" '{"tool_name":"MultiEdit","tool_input":{"edits":[{"new_string":$clean},{"new_string":$dirty}]}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "TODO"
}

@test "comment-checker: no warning for clean MultiEdit newString content" {
	local first="function foo() {\n  return 1;\n}"
	local second="function bar() {\n  return 2;\n}"
	local payload
	payload=$(jq -nc --arg first "$first" --arg second "$second" '{"tool_name":"MultiEdit","tool_input":{"edits":[{"newString":$first},{"newString":$second}]}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: warns for apply_patch added lines" {
	local patch=$'*** Begin Patch\n*** Update File: example.py\n@@\n def foo():\n+    # AI-generated helper\n+    return 1\n-    return 0\n*** End Patch'
	local payload
	payload=$(jq -nc --arg patch "$patch" '{"tool_name":"apply_patch","tool_input":{"patchText":$patch}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "AI attribution"
}

# ---------------------------------------------------------------------------
# g. empty-task-response: warns on empty/very short agent output
# ---------------------------------------------------------------------------

@test "empty-task-response: warns when agent output is empty" {
	local payload
	payload='{"tool_name":"Task","tool_input":{"subagent_type":"explore"},"tool_response":""}'

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "POOR AGENT OUTPUT"
}

@test "empty-task-response: warns when agent output is very short" {
	local payload
	payload='{"tool_name":"Task","tool_input":{"subagent_type":"explore"},"tool_response":"ok"}'

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "POOR AGENT OUTPUT"
}
