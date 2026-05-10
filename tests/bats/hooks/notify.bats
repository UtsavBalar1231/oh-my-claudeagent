#!/usr/bin/env bats
# Behavioral tests for notify.sh — Notification hook

load '../test_helper'

# ---------------------------------------------------------------------------
# a. idle_prompt: title branch fires; message passes through from platform
# ---------------------------------------------------------------------------

@test "notify: idle_prompt sets Waiting title and passes through platform message" {
	local payload
	payload=$(jq -nc '{
		session_id: "test-session-id",
		transcript_path: "/tmp/test-transcript.json",
		cwd: "/tmp/test-cwd",
		hook_event_name: "Notification",
		notification_type: "idle_prompt",
		title: "Claude Code",
		message: "Claude is waiting for your input"
	}')

	# notify.sh is async/observability-only — capture combined stdout+stderr
	run bash "$CLAUDE_PLUGIN_ROOT/scripts/notify.sh" <<< "$payload"
	assert_success

	# Verify the log entry written to notifications.jsonl reflects the correct type and title
	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/notifications.jsonl"
	assert [ -f "$log_file" ]

	local log_type log_title log_msg
	log_type=$(jq -r '.type' "$log_file")
	log_title=$(jq -r '.title' "$log_file")
	log_msg=$(jq -r '.message' "$log_file")

	# Title branch must have fired — must contain "Waiting"
	[[ "$log_title" == *"Waiting"* ]]
	# Message must be the platform-provided text, not a hardcoded override
	[ "$log_msg" = "Claude is waiting for your input" ]
	# Type field in log must match notification_type
	[ "$log_type" = "idle_prompt" ]
}

# ---------------------------------------------------------------------------
# b. permission_prompt: title branch fires; message passes through from platform
# ---------------------------------------------------------------------------

@test "notify: permission_prompt sets Permission Required title and passes through platform message" {
	local payload
	payload=$(jq -nc '{
		session_id: "test-session-id",
		transcript_path: "/tmp/test-transcript.json",
		cwd: "/tmp/test-cwd",
		hook_event_name: "Notification",
		notification_type: "permission_prompt",
		title: "Claude Code",
		message: "Claude needs your permission to use Bash"
	}')

	run bash "$CLAUDE_PLUGIN_ROOT/scripts/notify.sh" <<< "$payload"
	assert_success

	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/notifications.jsonl"
	assert [ -f "$log_file" ]

	local log_type log_title log_msg
	log_type=$(jq -r '.type' "$log_file")
	log_title=$(jq -r '.title' "$log_file")
	log_msg=$(jq -r '.message' "$log_file")

	# Title branch must have fired — must contain "Permission"
	[[ "$log_title" == *"Permission"* ]]
	# Message must be the platform-provided text, not a hardcoded override
	[ "$log_msg" = "Claude needs your permission to use Bash" ]
	[ "$log_type" = "permission_prompt" ]
}
