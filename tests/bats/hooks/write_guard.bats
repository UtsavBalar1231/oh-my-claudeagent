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

# ---------------------------------------------------------------------------
# Case 4: write to a notepad file → deny JSON, exit 0
# ---------------------------------------------------------------------------

@test "write-guard: emits permissionDecision deny for notepad path" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/notepads/my-plan/learnings.md"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success

	local decision
	decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')
	[ "$decision" = "deny" ]
}

@test "write-guard: deny output contains notepad_write reason for notepad path" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/notepads/my-plan/learnings.md"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success

	local reason
	reason=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
	assert [ -n "$reason" ]
	echo "$reason" | grep -qi "notepad_write"
}

@test "write-guard: non-notepad write unaffected by notepad deny case" {
	local target="$CLAUDE_PROJECT_ROOT/brand-new-file.txt"
	rm -f "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Case 5: unnormalised spellings of a protected path
# The guard matches path text, so `//`, `/./` and `/../` name the same notepad file
# without matching the pattern until the path is normalised.
# ---------------------------------------------------------------------------

@test "write-guard: denies a notepad path spelled with a doubled slash" {
	local target="$CLAUDE_PROJECT_ROOT/.omca//notepads/my-plan/learnings.md"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	[ "$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')" = "deny" ]
}

@test "write-guard: denies a notepad path spelled with a dot segment" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/./notepads/my-plan/learnings.md"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	[ "$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')" = "deny" ]
}

@test "write-guard: denies a notepad path spelled with a parent segment" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/state/../notepads/my-plan/learnings.md"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	[ "$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')" = "deny" ]
}

@test "write-guard: a parent segment leading out of the notepad dir is not denied" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/notepads/../scratch.md"
	rm -f "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Case 6: Edit and MultiEdit carry the same file_path field as Write
# ---------------------------------------------------------------------------

@test "write-guard: denies a notepad Edit payload" {
	local target="$CLAUDE_PROJECT_ROOT/.omca//notepads/my-plan/learnings.md"

	local payload
	payload=$(printf '{"tool_name":"Edit","tool_input":{"file_path":"%s","old_string":"a","new_string":"b"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	[ "$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')" = "deny" ]
}

@test "write-guard: denies a MultiEdit payload targeting the evidence file" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/state/./verification-evidence.json"

	local payload
	payload=$(printf '{"tool_name":"MultiEdit","tool_input":{"file_path":"%s","edits":[]}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	[ "$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')" = "deny" ]
}

@test "write-guard: OMCA_DISABLED_HOOKS=write-guard bypasses notepad deny" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/notepads/my-plan/learnings.md"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	OMCA_DISABLED_HOOKS="write-guard" run_hook "write-guard.sh" "$payload"
	assert_success
	assert_output ""
}
