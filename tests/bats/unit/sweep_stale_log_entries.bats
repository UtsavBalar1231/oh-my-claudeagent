#!/usr/bin/env bats
# Unit tests for scripts/sweep-stale-log-entries.sh

load '../test_helper'

# Seed a log file with 3 valid + 2 stale entries and return the path.
# Must be called after setup() has set CLAUDE_PROJECT_ROOT.
seed_log() {
	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/hook-errors.jsonl"
	printf '%s\n' \
		'{"timestamp":"2026-05-01T10:00:00Z","hook":"session-init.sh","error":"some error"}' \
		'{"timestamp":"","hook":"post-edit.sh","error":"flock timeout on recent-edits"}' \
		'{"timestamp":"2026-05-01T11:00:00Z","hook":"post-edit.sh","error":"valid post-edit entry"}' \
		'{"timestamp":"","hook":"post-edit.sh","error":"another stale entry"}' \
		'{"timestamp":"2026-05-02T09:00:00Z","hook":"subagent-start.sh","error":"marker missing"}' \
		> "$log_file"
	echo "$log_file"
}

@test "sweep removes stale entries and preserves valid ones" {
	local log_file
	log_file=$(seed_log)

	run bash "$CLAUDE_PLUGIN_ROOT/scripts/sweep-stale-log-entries.sh" "$log_file"
	assert_success

	local count
	count=$(wc -l < "$log_file")
	[ "$count" -eq 3 ]
}

@test "sweep preserves post-edit.sh entry with a valid timestamp" {
	local log_file
	log_file=$(seed_log)

	run bash "$CLAUDE_PLUGIN_ROOT/scripts/sweep-stale-log-entries.sh" "$log_file"
	assert_success

	grep -q '"hook":"post-edit.sh"' "$log_file"
	grep -q '"timestamp":"2026-05-01T11:00:00Z"' "$log_file"
}

@test "sweep keeps empty-timestamp entry from a different hook" {
	local log_file
	log_file=$(seed_log)
	printf '%s\n' '{"timestamp":"","hook":"other-hook.sh","error":"keep me"}' >> "$log_file"

	run bash "$CLAUDE_PLUGIN_ROOT/scripts/sweep-stale-log-entries.sh" "$log_file"
	assert_success

	grep -q '"hook":"other-hook.sh"' "$log_file"
}

@test "sweep is idempotent — running twice produces same output" {
	local log_file
	log_file=$(seed_log)

	run bash "$CLAUDE_PLUGIN_ROOT/scripts/sweep-stale-log-entries.sh" "$log_file"
	assert_success
	local first_count
	first_count=$(wc -l < "$log_file")

	run bash "$CLAUDE_PLUGIN_ROOT/scripts/sweep-stale-log-entries.sh" "$log_file"
	assert_success
	local second_count
	second_count=$(wc -l < "$log_file")

	[ "$first_count" -eq "$second_count" ]
}

@test "sweep exits 0 when file does not exist" {
	run bash "$CLAUDE_PLUGIN_ROOT/scripts/sweep-stale-log-entries.sh" "/nonexistent/path/hook-errors.jsonl"
	assert_success
}

@test "sweep does not delete the log file when all entries are stale" {
	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/hook-errors.jsonl"
	printf '%s\n' '{"timestamp":"","hook":"post-edit.sh","error":"stale"}' > "$log_file"

	run bash "$CLAUDE_PLUGIN_ROOT/scripts/sweep-stale-log-entries.sh" "$log_file"
	assert_success

	[ -f "$log_file" ]
	local count
	count=$(wc -l < "$log_file")
	[ "$count" -eq 0 ]
}
