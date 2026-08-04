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
	for f in session.json recent-edits.json \
		injected-context-dirs.json error-counts.json; do
		write_state "$f" '{"stale":true}'
	done

	run_cleanup "$END_PAYLOAD"
	assert_success

	for f in session.json recent-edits.json \
		injected-context-dirs.json error-counts.json; do
		assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/$f" ]
	done
}

# ─── c. resume skips temp-file cleanup ───────────────────────────────────────

@test "session-cleanup: preserves ephemeral files on resume" {
	write_state "session.json" '{"sessionId":"alive-sid"}'
	write_state "recent-edits.json" '{"files":["a.sh"]}'

	run_cleanup "$RESUME_PAYLOAD"
	assert_success

	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/session.json" ]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/recent-edits.json" ]
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
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/evidence"
	printf '%s' '{"entries":[]}' > "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json"
	write_state "team-state.json" '{"teams":[]}'

	run_cleanup "$END_PAYLOAD"
	assert_success

	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json" ]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json" ]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/team-state.json" ]
}

# ─── h. exits 0 with no state dir ────────────────────────────────────────────

@test "session-cleanup: exits 0 when state and log dirs are empty" {
	# setup() already creates empty state/ and logs/ dirs — just run the script
	run_cleanup "$END_PAYLOAD"
	assert_success
}

# ─── i. authoritative binding GC ─────────────────────────────────────────────

@test "session-cleanup: prunes the ending session's boulder.json binding" {
	write_state "session.json" '{"sessionId":"sess-ending"}'
	write_state "boulder.json" '{
		"plans": {"my-plan": {"active_plan": "/tmp/plan.md", "session_ids": ["sess-ending"], "agent": "sisyphus"}},
		"bindings": {"sess-ending": {"plan_name": "my-plan", "bound_at": "2026-01-01T00:00:00Z"}}
	}'

	run_cleanup "$END_PAYLOAD"
	assert_success

	local boulder_file="$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json"
	assert [ -f "$boulder_file" ]
	run jq -e '.bindings | has("sess-ending")' "$boulder_file"
	assert_failure
	run jq -e '.plans["my-plan"]' "$boulder_file"
	assert_success
}

@test "session-cleanup: leaves concurrent sessions' bindings intact" {
	write_state "session.json" '{"sessionId":"sess-ending"}'
	write_state "boulder.json" '{
		"plans": {"my-plan": {"active_plan": "/tmp/plan.md", "session_ids": ["sess-ending", "sess-other"], "agent": "sisyphus"}},
		"bindings": {
			"sess-ending": {"plan_name": "my-plan", "bound_at": "2026-01-01T00:00:00Z"},
			"sess-other": {"plan_name": "my-plan", "bound_at": "2026-01-01T00:00:00Z"}
		}
	}'

	run_cleanup "$END_PAYLOAD"
	assert_success

	local boulder_file="$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json"
	run jq -e '.bindings | has("sess-other")' "$boulder_file"
	assert_success
}

@test "session-cleanup: prunes the binding named by the payload, not the one in session.json" {
	write_state "session.json" '{"sessionId":"sess-parent"}'
	write_state "boulder.json" '{
		"plans": {"my-plan": {"active_plan": "/tmp/plan.md", "session_ids": ["sess-parent", "sess-fork"], "agent": "sisyphus"}},
		"bindings": {
			"sess-parent": {"plan_name": "my-plan", "bound_at": "2026-01-01T00:00:00Z"},
			"sess-fork": {"plan_name": "my-plan", "bound_at": "2026-01-01T00:00:00Z"}
		}
	}'

	run_cleanup '{"hook_event_name":"SessionEnd","reason":"stop","session_id":"sess-fork"}'
	assert_success

	local boulder_file="$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json"
	run jq -e '.bindings | has("sess-fork")' "$boulder_file"
	assert_failure
	run jq -e '.bindings | has("sess-parent")' "$boulder_file"
	assert_success
}

@test "session-cleanup: leaves shared state alone when another session owns session.json" {
	write_state "session.json" '{"sessionId":"sess-parent"}'
	write_state "recent-edits.json" '{"files":["a.sh"]}'
	write_state "injected-context-dirs.json" '{"/parent/dir|100":"true"}'

	run_cleanup '{"hook_event_name":"SessionEnd","reason":"stop","session_id":"sess-fork"}'
	assert_success

	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/session.json" ]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/recent-edits.json" ]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/injected-context-dirs.json" ]
}

@test "session-cleanup: no-ops the binding prune when session id is unknown" {
	write_state "boulder.json" '{
		"plans": {"my-plan": {"active_plan": "/tmp/plan.md", "session_ids": ["sess-x"], "agent": "sisyphus"}},
		"bindings": {"sess-x": {"plan_name": "my-plan", "bound_at": "2026-01-01T00:00:00Z"}}
	}'

	run_cleanup "$END_PAYLOAD"
	assert_success

	local boulder_file="$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json"
	run jq -e '.bindings | has("sess-x")' "$boulder_file"
	assert_success
}

# ── log prune ────────────────────────────────────────────────────────────────
# Regression: `-mtime +7` can never match a log that every session appends to,
# so the hot JSONL logs grew without bound, and the `*.jsonl` glob missed the
# `.log` files entirely. The prune is by size now, keeping the recent tail.

_fill_log() {
	local name="$1" lines="$2"
	python3 - "$CLAUDE_PROJECT_ROOT/.omca/logs/$name" "$lines" <<'PY'
import sys
path, lines = sys.argv[1], int(sys.argv[2])
with open(path, "w") as fh:
    for i in range(lines):
        fh.write("entry %d %s\n" % (i, "x" * 100))
PY
}

@test "session-cleanup: prunes an oversized jsonl log an mtime rule could never reach" {
	_fill_log "hook-timing.jsonl" 20000
	run_cleanup "$END_PAYLOAD"
	assert_success

	local kept
	kept=$(wc -l < "$CLAUDE_PROJECT_ROOT/.omca/logs/hook-timing.jsonl")
	[ "$kept" -eq 1000 ]
	# The newest entries are the ones worth keeping.
	run tail -n 1 "$CLAUDE_PROJECT_ROOT/.omca/logs/hook-timing.jsonl"
	assert_output --partial 'entry 19999'
}

@test "session-cleanup: prunes an oversized .log file, which the old glob missed" {
	_fill_log "agent-spawns.log" 20000
	run_cleanup "$END_PAYLOAD"
	assert_success
	[ "$(wc -l < "$CLAUDE_PROJECT_ROOT/.omca/logs/agent-spawns.log")" -eq 1000 ]
}

@test "session-cleanup: leaves a small log untouched" {
	_fill_log "config-changes.log" 10
	run_cleanup "$END_PAYLOAD"
	assert_success
	[ "$(wc -l < "$CLAUDE_PROJECT_ROOT/.omca/logs/config-changes.log")" -eq 10 ]
}

@test "session-cleanup: rotates an oversized log from a same-directory temp, not \$TMPDIR" {
	_fill_log "hook-timing.jsonl" 20000
	TMPDIR="$BATS_TEST_TMPDIR/absent" HOOK_INPUT="$END_PAYLOAD" \
		run bash "$CLAUDE_PLUGIN_ROOT/scripts/session-cleanup.sh" <<< "$END_PAYLOAD"
	assert_success
	[ "$(wc -l < "$CLAUDE_PROJECT_ROOT/.omca/logs/hook-timing.jsonl")" -eq 1000 ]
}

@test "session-cleanup: replaces boulder.json from a same-directory temp, not \$TMPDIR" {
	write_state "session.json" '{"sessionId":"sess-ending"}'
	write_state "boulder.json" '{
		"plans": {"my-plan": {"active_plan": "/tmp/plan.md", "session_ids": ["sess-ending"], "agent": "sisyphus"}},
		"bindings": {"sess-ending": {"plan_name": "my-plan", "bound_at": "2026-01-01T00:00:00Z"}}
	}'

	TMPDIR="$BATS_TEST_TMPDIR/absent" HOOK_INPUT="$END_PAYLOAD" \
		run bash "$CLAUDE_PLUGIN_ROOT/scripts/session-cleanup.sh" <<< "$END_PAYLOAD"
	assert_success

	run jq -e '.bindings | has("sess-ending")' "$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json"
	assert_failure
}

@test "session-cleanup: runs the binding GC before log rotation, so a kill drops only the log trim" {
	local shim="$BATS_TEST_TMPDIR/shim"
	mkdir -p "$shim"
	printf '#!/bin/sh\nsleep 10\n' > "$shim/tail"
	chmod +x "$shim/tail"

	write_state "session.json" '{"sessionId":"sess-ending"}'
	write_state "boulder.json" '{
		"plans": {"my-plan": {"active_plan": "/tmp/plan.md", "session_ids": ["sess-ending"], "agent": "sisyphus"}},
		"bindings": {"sess-ending": {"plan_name": "my-plan", "bound_at": "2026-01-01T00:00:00Z"}}
	}'
	_fill_log "hook-timing.jsonl" 20000

	PATH="$shim:$PATH" HOOK_INPUT="$END_PAYLOAD" \
		run timeout 2 bash "$CLAUDE_PLUGIN_ROOT/scripts/session-cleanup.sh" <<< "$END_PAYLOAD"

	run jq -e '.bindings | has("sess-ending")' "$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json"
	assert_failure
}

@test "session-cleanup: invalidates session-init's hook-errors cursor when it rotates that log" {
	write_state "hook-errors-cursor" "5 245"
	_fill_log "hook-errors.jsonl" 20000

	run_cleanup "$END_PAYLOAD"
	assert_success

	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/hook-errors-cursor" ]
}

@test "session-cleanup: keeps session-init's hook-errors cursor when that log is not rotated" {
	write_state "hook-errors-cursor" "5 245"
	_fill_log "hook-errors.jsonl" 10

	run_cleanup "$END_PAYLOAD"
	assert_success

	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/hook-errors-cursor" ]
}
