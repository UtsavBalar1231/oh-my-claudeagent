#!/usr/bin/env bats
# Behavioral tests for write-guard.sh: deny path and nudge path

load '../test_helper'

# ---------------------------------------------------------------------------
# Case 1: write to verification-evidence.json → deny JSON, exit 0
# ---------------------------------------------------------------------------

@test "write-guard: emits permissionDecision deny for verification-evidence.json" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/state/verification-evidence.json"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success

	local decision
	decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')
	[ "$decision" = "deny" ]
}

@test "write-guard: deny output contains permissionDecisionReason for evidence file" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/state/verification-evidence.json"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success

	local reason
	reason=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
	assert [ -n "$reason" ]
	echo "$reason" | grep -qi "evidence_log"
}

@test "write-guard: deny output has hookEventName PreToolUse for evidence file" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/state/verification-evidence.json"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success

	local event
	event=$(echo "$output" | jq -r '.hookSpecificOutput.hookEventName // empty')
	[ "$event" = "PreToolUse" ]
}

# ---------------------------------------------------------------------------
# Case 2: write to a new file (does not exist) → no output, proceed
# ---------------------------------------------------------------------------

@test "write-guard: no output when target file does not exist" {
	local target="$CLAUDE_PROJECT_ROOT/brand-new-file.txt"
	rm -f "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Case 3: write to a file that already exists → past-tense nudge additionalContext
# ---------------------------------------------------------------------------

@test "write-guard: emits additionalContext nudge when target file exists" {
	local target="$CLAUDE_PROJECT_ROOT/existing-file.txt"
	printf 'some content' > "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success

	local ctx
	ctx=$(get_context)
	assert [ -n "$ctx" ]
}

@test "write-guard: nudge wording is past-tense (Detected manual write)" {
	local target="$CLAUDE_PROJECT_ROOT/existing-file.txt"
	printf 'some content' > "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success

	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -qi "Detected manual write"
}

@test "write-guard: nudge mentions Edit for existing file" {
	local target="$CLAUDE_PROJECT_ROOT/existing-file.txt"
	printf 'some content' > "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success

	local ctx
	ctx=$(get_context)
	echo "$ctx" | grep -qi "Edit"
}

@test "write-guard: nudge does not emit permissionDecision deny for existing file" {
	local target="$CLAUDE_PROJECT_ROOT/existing-file.txt"
	printf 'some content' > "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success

	local decision
	decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')
	[ -z "$decision" ]
}
