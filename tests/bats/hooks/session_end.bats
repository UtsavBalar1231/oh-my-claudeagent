#!/usr/bin/env bats
# Behavioral tests for session-cleanup.sh (SessionEnd hook)

load '../test_helper'

END_PAYLOAD='{"hook_event_name":"SessionEnd","reason":"stop"}'
RESUME_PAYLOAD='{"hook_event_name":"SessionEnd","reason":"resume"}'

# Helper: run session-cleanup with an explicit HOOK_INPUT env so common.sh
# skips the cat-stdin path.
run_cleanup() {
	local payload="$1"
	HOOK_INPUT="$payload" run bash "$CLAUDE_PLUGIN_ROOT/scripts/session-cleanup.sh" <<< "$payload"
}

# ─── a. log entry written ────────────────────────────────────────────────────

@test "session-cleanup: writes session_end entry to sessions.jsonl" {
	write_state "../logs/sessions.jsonl" ""   # pre-create log file (write_state uses state/ dir)
	# Provide a session.json so the script can read a sessionId
	write_state "session.json" '{"sessionId":"test-sid-abc"}'

	run_cleanup "$END_PAYLOAD"
	assert_success

	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/sessions.jsonl"
	assert [ -f "$log_file" ]

	local event
	event=$(tail -1 "$log_file" | jq -r '.event')
	[ "$event" = "session_end" ]
}

# ─── b. temp files deleted on normal stop ────────────────────────────────────

@test "session-cleanup: removes ephemeral state files on stop" {
	for f in session.json subagents.json recent-edits.json \
		injected-context-dirs.json agent-usage.json \
		error-counts.json active-agents.json active-agents.lock; do
		write_state "$f" '{"stale":true}'
	done

	run_cleanup "$END_PAYLOAD"
	assert_success

	for f in session.json subagents.json recent-edits.json \
		injected-context-dirs.json agent-usage.json \
		error-counts.json active-agents.json active-agents.lock; do
		assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/$f" ]
	done
}

# ─── c. pending-final-verify cleared on stop ─────────────────────────────────

@test "session-cleanup: removes pending-final-verify.json on stop" {
	write_state "pending-final-verify.json" \
		'{"plan_path":"/tmp/test-plan.md","marked_at":9999999999,"session_id":"test-sid"}'

	run_cleanup "$END_PAYLOAD"
	assert_success

	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/pending-final-verify.json" ]
}

# ─── d. resume skips temp-file cleanup ───────────────────────────────────────

@test "session-cleanup: preserves ephemeral files on resume" {
	write_state "session.json" '{"sessionId":"alive-sid"}'
	write_state "recent-edits.json" '{"files":["a.sh"]}'
	write_state "pending-final-verify.json" \
		'{"plan_path":"/tmp/plan.md","marked_at":9999999999}'

	run_cleanup "$RESUME_PAYLOAD"
	assert_success

	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/session.json" ]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/recent-edits.json" ]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/pending-final-verify.json" ]
}

# ─── e. orphan worktree tracking files removed ───────────────────────────────

@test "session-cleanup: removes orphan worktree tracking files for missing paths" {
	local wt_dir="$CLAUDE_PROJECT_ROOT/.omca/state/worktrees"
	mkdir -p "$wt_dir"
	# Write a tracking file pointing at a path that does not exist
	printf '{"worktreePath":"/nonexistent/worktree/path"}' > "$wt_dir/orphan.json"

	run_cleanup "$END_PAYLOAD"
	assert_success

	assert [ ! -f "$wt_dir/orphan.json" ]
}

# ─── f. valid worktree tracking file kept ────────────────────────────────────

@test "session-cleanup: keeps worktree tracking file when path exists" {
	local wt_dir="$CLAUDE_PROJECT_ROOT/.omca/state/worktrees"
	mkdir -p "$wt_dir"
	# Write a tracking file pointing at a real existing directory
	printf '{"worktreePath":"%s"}' "$CLAUDE_PROJECT_ROOT" > "$wt_dir/valid.json"

	run_cleanup "$END_PAYLOAD"
	assert_success

	assert [ -f "$wt_dir/valid.json" ]
}

# ─── g. persistent state files are NOT deleted ───────────────────────────────

@test "session-cleanup: preserves boulder.json and verification-evidence.json" {
	write_state "boulder.json" '{"active_plan":"/tmp/my-plan.md"}'
	write_state "verification-evidence.json" '{"entries":[]}'
	write_state "ralph-state.json" '{"status":"active"}'
	write_state "team-state.json" '{"teams":[]}'

	run_cleanup "$END_PAYLOAD"
	assert_success

	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json" ]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/verification-evidence.json" ]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json" ]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/team-state.json" ]
}

# ─── h. exits 0 with no state dir ────────────────────────────────────────────

@test "session-cleanup: exits 0 when state and log dirs are empty" {
	# setup() already creates empty state/ and logs/ dirs — just run the script
	run_cleanup "$END_PAYLOAD"
	assert_success
}
