#!/usr/bin/env bats
# Tests for scripts/setup-maintenance.sh (Setup event).
#
# The script is registered under both Setup matchers and branches on the payload's
# `trigger` field, so each test asserts the branch taken by two independent signals:
# the emitted additionalContext, and whether the maintenance sweeps actually ran
# (a dead-PID .in_use marker is removed only by the maintenance branch).

load '../test_helper'

SETUP_SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../../.." && pwd)/scripts/setup-maintenance.sh"

setup() {
	export CLAUDE_PLUGIN_ROOT="$BATS_TEST_TMPDIR/plugin"
	export CLAUDE_PROJECT_ROOT="$BATS_TEST_TMPDIR/project"
	export HOOK_STATE_DIR="$CLAUDE_PROJECT_ROOT/.omca/state"
	export HOOK_LOG_DIR="$CLAUDE_PROJECT_ROOT/.omca/logs"
	mkdir -p "$CLAUDE_PLUGIN_ROOT/.in_use" "$HOOK_STATE_DIR" "$HOOK_LOG_DIR"

	DEAD_MARKER="$CLAUDE_PLUGIN_ROOT/.in_use/999999"
	if [ -d "/proc/999999" ] || kill -0 999999 2>/dev/null; then
		skip "PID 999999 is alive on this system -- cannot use it as a sweep probe"
	fi
	printf '{"pid":999999}\n' > "$DEAD_MARKER"
}

@test "setup-maintenance: init runs the dependency check and not the sweeps" {
	run bash "$SETUP_SCRIPT" <<< '{"hook_event_name":"Setup","trigger":"init"}'
	[ "$status" -eq 0 ]
	[[ "$output" == *"dependency report"* ]]
	[[ "$output" == *"jq:"* ]]
	[[ "$output" != *"sweeps"* ]]
	[ -f "$DEAD_MARKER" ]
}

@test "setup-maintenance: maintenance runs the sweeps and not the dependency check" {
	run bash "$SETUP_SCRIPT" <<< '{"hook_event_name":"Setup","trigger":"maintenance"}'
	[ "$status" -eq 0 ]
	[[ "$output" == *"sweeps"* ]]
	[[ "$output" == *"gc-in-use"* ]]
	[[ "$output" != *"dependency report"* ]]
	[ ! -f "$DEAD_MARKER" ]
}

@test "setup-maintenance: unrecognized trigger is a silent no-op" {
	run bash "$SETUP_SCRIPT" <<< '{"hook_event_name":"Setup","trigger":"nonsense"}'
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ -f "$DEAD_MARKER" ]
}

@test "setup-maintenance: absent trigger is a silent no-op" {
	run bash "$SETUP_SCRIPT" <<< '{"hook_event_name":"Setup"}'
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ -f "$DEAD_MARKER" ]
}

@test "setup-maintenance: emitted output is Setup additionalContext JSON" {
	run bash "$SETUP_SCRIPT" <<< '{"trigger":"init"}'
	[ "$status" -eq 0 ]
	run jq -r '.hookSpecificOutput.hookEventName' <<< "$output"
	[ "$output" = "Setup" ]
}
