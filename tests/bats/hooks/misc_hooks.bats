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
# f2. comment-checker: slop-pattern categories (code-restating, filler words,
# decorative separators, trivial doc comments, context-free TODO/FIXME)
# ---------------------------------------------------------------------------

@test "comment-checker: warns on code-restating comment" {
	local content=$'# set user name to input value\nuser_name = input_value'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "restates the following code line"
}

@test "comment-checker: no warning when comment adds information code doesn't restate" {
	local content=$'# cache the previous input value for diffing on next call\nuser_name = input_value'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: warns on filler-word qualifier comment" {
	local content=$'# obviously this handles the edge case\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "Filler-word comment"
}

@test "comment-checker: no warning for comment without filler qualifiers" {
	local content=$'# handles the edge case for empty input\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: warns on decorative separator comment" {
	local content=$'# ====================\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "Decorative separator comment"
}

@test "comment-checker: no warning for a labeled section-banner comment" {
	local content=$'# === Section: Setup ===\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: warns on trivial doc comment above a one-line function" {
	local content=$'# returns the user id\ndef get_user_id():\n    return self.id\n'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "Doc comment adds nothing beyond the function name"
}

@test "comment-checker: no warning for a doc comment that adds real information" {
	local content=$'# validates against the external billing service and retries on timeout\ndef get_user_id():\n    return self.id\n'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: warns on context-free TODO with no ref/owner/explanation" {
	local content=$'# TODO fix this\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "Context-free TODO/FIXME"
}

@test "comment-checker: no warning for TODO carrying an issue reference" {
	local content=$'# TODO(#123): fix this after upstream releases a patch\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: @allow bypasses slop-pattern checks on that line" {
	local content=$'# obviously simple @allow\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: comment-checker-disable-file marker exempts the whole payload" {
	local content=$'# comment-checker-disable-file\n# obviously this is bad\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: OMCA_DISABLED_HOOKS bypasses detection entirely" {
	local content="# AI-generated code\ndef foo():\n    pass"
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	OMCA_DISABLED_HOOKS="comment-checker" run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
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
