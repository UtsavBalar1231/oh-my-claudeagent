#!/usr/bin/env bats
# Behavioral tests for post-edit.sh — verifies edits.jsonl records correct success values

load '../test_helper'

# ---------------------------------------------------------------------------
# a. success=true: tool_response.success true → edits.jsonl records true
# ---------------------------------------------------------------------------

@test "post-edit: records success:true when tool_response.success is true" {
	local payload
	payload=$(jq -nc '{
		tool_name: "Write",
		tool_input: { file_path: "/some/file.sh" },
		tool_response: { success: true }
	}')

	run_hook "post-edit.sh" "$payload"
	assert_success

	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/edits.jsonl"
	assert [ -f "$log_file" ]

	local success_val
	success_val=$(tail -1 "$log_file" | jq -r '.success')
	[ "$success_val" = "true" ]
}

# ---------------------------------------------------------------------------
# b. success=false: tool_response.success false → edits.jsonl records false
# ---------------------------------------------------------------------------

@test "post-edit: records success:false when tool_response.success is false" {
	local payload
	payload=$(jq -nc '{
		tool_name: "Write",
		tool_input: { file_path: "/some/file.sh" },
		tool_response: { success: false, error: "permission denied" }
	}')

	run_hook "post-edit.sh" "$payload"
	assert_success

	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/edits.jsonl"
	assert [ -f "$log_file" ]

	local success_val
	success_val=$(tail -1 "$log_file" | jq -r '.success')
	[ "$success_val" = "false" ]
}

# ---------------------------------------------------------------------------
# c. fallback: missing tool_response → edits.jsonl records true (default)
# ---------------------------------------------------------------------------

@test "post-edit: defaults to success:true when tool_response is absent" {
	local payload
	payload=$(jq -nc '{
		tool_name: "Edit",
		tool_input: { file_path: "/some/file.sh" }
	}')

	run_hook "post-edit.sh" "$payload"
	assert_success

	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/edits.jsonl"
	assert [ -f "$log_file" ]

	local success_val
	success_val=$(tail -1 "$log_file" | jq -r '.success')
	[ "$success_val" = "true" ]
}
