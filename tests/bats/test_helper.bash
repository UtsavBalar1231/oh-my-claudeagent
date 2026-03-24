# BATS test helper — shared fixtures and helpers for hook behavioral tests
# Load this in test files with: load '../test_helper'

# Resolve the directory this helper lives in (tests/bats/)
_TEST_HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load bats-support and bats-assert using absolute paths
load "$_TEST_HELPER_DIR/bats-support/load"
load "$_TEST_HELPER_DIR/bats-assert/load"

setup() {
	# Create isolated project root for this test
	export CLAUDE_PROJECT_ROOT="$BATS_TEST_TMPDIR/project"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/state"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/logs"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/rules"

	# Plugin root = repo root = two levels up from tests/bats/
	export CLAUDE_PLUGIN_ROOT="$(cd "$_TEST_HELPER_DIR/../.." && pwd)"

	export CLAUDE_SESSION_ID="bats-test-session"
}

# Run a hook script with an inline JSON payload via stdin
# Usage: run_hook <script-name> <json-string>
run_hook() {
	local script="$1"
	local payload="$2"
	run bash "$CLAUDE_PLUGIN_ROOT/scripts/$script" <<< "$payload"
}

# Run a hook script with a fixture file via stdin
# Usage: run_hook_file <script-name> <fixture-path>
run_hook_file() {
	local script="$1"
	local fixture="$2"
	run bash "$CLAUDE_PLUGIN_ROOT/scripts/$script" < "$fixture"
}

# Extract additionalContext from hook output
# Usage: get_context  (reads $output set by run_hook / run_hook_file)
get_context() {
	echo "$output" | jq -r '.hookSpecificOutput.additionalContext // empty'
}

# Write a file to the isolated state directory
# Usage: write_state <filename> <content>
write_state() {
	local filename="$1"
	local content="$2"
	printf '%s' "$content" > "$CLAUDE_PROJECT_ROOT/.omca/state/$filename"
}

# Read a file from the isolated state directory
# Usage: read_state <filename>
read_state() {
	local filename="$1"
	cat "$CLAUDE_PROJECT_ROOT/.omca/state/$filename"
}
