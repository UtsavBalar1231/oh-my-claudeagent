#!/usr/bin/env bats
# Behavioral tests for lifecycle-state.sh

load '../test_helper'

# ---------------------------------------------------------------------------
# WorktreeRemove: reads .worktree_path, derives name via basename
# ---------------------------------------------------------------------------

@test "lifecycle-state WorktreeRemove: removes tracking file derived from worktree_path basename" {
	# Create the worktrees sub-dir and a fake tracking file
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/state/worktrees"
	printf '{"name":"my-worktree","createdAt":"2026-01-01T00:00:00Z"}\n' \
		> "$CLAUDE_PROJECT_ROOT/.omca/state/worktrees/my-worktree.json"

	local payload
	payload=$(jq -nc '{"hook_event_name":"WorktreeRemove","session_id":"bats-test","cwd":"/repo","worktree_path":"/tmp/some/path/my-worktree"}')

	run_hook "lifecycle-state.sh" "$payload"
	assert_success

	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/worktrees/my-worktree.json" ]
}

@test "lifecycle-state WorktreeRemove: exits 0 cleanly when no tracking file exists" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/state/worktrees"

	local payload
	payload=$(jq -nc '{"hook_event_name":"WorktreeRemove","session_id":"bats-test","cwd":"/repo","worktree_path":"/tmp/some/path/nonexistent-worktree"}')

	run_hook "lifecycle-state.sh" "$payload"
	assert_success
}

@test "lifecycle-state WorktreeRemove: exits 1 with message when worktree_path is missing" {
	local payload
	payload=$(jq -nc '{"hook_event_name":"WorktreeRemove","session_id":"bats-test","cwd":"/repo"}')

	run_hook "lifecycle-state.sh" "$payload"
	assert_failure
	[ "$status" -eq 1 ]
	[[ "$output" == *"worktree_path"* ]]
}

@test "lifecycle-state WorktreeRemove: appends event to worktrees.jsonl log" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/state/worktrees"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/logs"

	local payload
	payload=$(jq -nc '{"hook_event_name":"WorktreeRemove","session_id":"bats-test","cwd":"/repo","worktree_path":"/abs/path/feature-branch"}')

	run_hook "lifecycle-state.sh" "$payload"
	assert_success

	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/worktrees.jsonl"
	assert [ -f "$log_file" ]

	local event_name
	event_name=$(tail -1 "$log_file" | jq -r '.event')
	[ "$event_name" = "worktree_remove" ]

	local name
	name=$(tail -1 "$log_file" | jq -r '.name')
	[ "$name" = "feature-branch" ]
}

# ---------------------------------------------------------------------------
# TaskCreated: logs to tasks.jsonl
# ---------------------------------------------------------------------------

@test "lifecycle-state TaskCreated: logs task_created event to tasks.jsonl" {
	local payload
	payload=$(jq -nc '{"hook_event_name":"TaskCreated","task_id":"t-001","task_subject":"Test task","teammate_name":"executor"}')

	run_hook "lifecycle-state.sh" "$payload"
	assert_success

	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/tasks.jsonl"
	assert [ -f "$log_file" ]

	local event
	event=$(tail -1 "$log_file" | jq -r '.event')
	[ "$event" = "task_created" ]

	local task_id
	task_id=$(tail -1 "$log_file" | jq -r '.task_id')
	[ "$task_id" = "t-001" ]
}

# ---------------------------------------------------------------------------
# CwdChanged: updates repo-state.json
# ---------------------------------------------------------------------------

@test "lifecycle-state CwdChanged: writes repo-state.json" {
	local payload
	payload=$(jq -nc --arg cwd "$CLAUDE_PROJECT_ROOT" \
		'{"hook_event_name":"CwdChanged","old_cwd":"/old","new_cwd":$cwd}')

	run_hook "lifecycle-state.sh" "$payload"
	assert_success

	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/repo-state.json" ]

	local event
	event=$(jq -r '.lastEvent' "$CLAUDE_PROJECT_ROOT/.omca/state/repo-state.json")
	[ "$event" = "CwdChanged" ]
}
