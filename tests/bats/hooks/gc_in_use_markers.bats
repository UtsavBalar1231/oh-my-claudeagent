#!/usr/bin/env bats
# Tests for scripts/gc-in-use-markers.sh
#
# Verifies stale PID-marker GC at session-init:
#   - live PID marker is preserved
#   - dead PID marker is removed
#   - forked-and-exited child PID marker is removed
#   - empty .in_use/ dir is handled gracefully (exit 0)
#   - missing .in_use/ dir is handled gracefully (exit 0)

load '../test_helper'

# Resolve script path once
GC_SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../../.." && pwd)/scripts/gc-in-use-markers.sh"

setup() {
	# Override CLAUDE_PLUGIN_ROOT so GC script operates on a tmp dir,
	# never touching the real ~/.claude/.in_use/ directory.
	export CLAUDE_PLUGIN_ROOT="$BATS_TEST_TMPDIR/plugin"
	mkdir -p "$CLAUDE_PLUGIN_ROOT/.in_use"
}

@test "gc-in-use-markers: live PID marker (current $$) is preserved" {
	local marker="$CLAUDE_PLUGIN_ROOT/.in_use/$$"
	printf '{"pid":%s,"procStart":"x"}\n' "$$" > "$marker"

	run bash "$GC_SCRIPT"
	[ "$status" -eq 0 ]
	[ -f "$marker" ]
}

@test "gc-in-use-markers: dead PID 999999 marker is removed" {
	local marker="$CLAUDE_PLUGIN_ROOT/.in_use/999999"
	printf '{"pid":999999,"procStart":"x"}\n' > "$marker"

	# Confirm PID 999999 is actually dead before asserting removal.
	# If somehow the system has a process with PID 999999, skip.
	if [ -d "/proc/999999" ] || kill -0 999999 2>/dev/null; then
		skip "PID 999999 is alive on this system -- cannot test dead-PID removal"
	fi

	run bash "$GC_SCRIPT"
	[ "$status" -eq 0 ]
	[ ! -f "$marker" ]
}

@test "gc-in-use-markers: forked-and-exited child PID marker is removed" {
	( true ) &
	local child_pid=$!
	wait "$child_pid"

	# Give the OS a moment to fully reap the child and mark the PID as dead.
	sleep 0.1

	# Only assert removal if the PID is actually dead; skip on rare PID-reuse.
	if [ -d "/proc/${child_pid}" ] || kill -0 "${child_pid}" 2>/dev/null; then
		skip "child PID ${child_pid} still alive (PID reused) -- skipping"
	fi

	local marker="$CLAUDE_PLUGIN_ROOT/.in_use/$child_pid"
	printf '{"pid":%s,"procStart":"x"}\n' "${child_pid}" > "$marker"

	run bash "$GC_SCRIPT"
	[ "$status" -eq 0 ]
	[ ! -f "$marker" ]
}

@test "gc-in-use-markers: empty .in_use dir is a no-op (exit 0)" {
	# setup() already created an empty .in_use dir -- nothing to add.
	run bash "$GC_SCRIPT"
	[ "$status" -eq 0 ]
}

@test "gc-in-use-markers: missing .in_use dir is a no-op (exit 0)" {
	rm -rf "$CLAUDE_PLUGIN_ROOT/.in_use"
	run bash "$GC_SCRIPT"
	[ "$status" -eq 0 ]
}
