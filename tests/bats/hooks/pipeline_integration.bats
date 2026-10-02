#!/usr/bin/env bats
# Cross-script state pipeline integration tests
# These tests verify the STATE HANDOFF between hook scripts, not individual behavior.
# If script A changes its state file format, these tests catch the breakage in script B.

load '../test_helper'

# Override setup to use BATS_FILE_TMPDIR for cross-test persistence within pipeline sequences
setup() {
	export CLAUDE_PROJECT_ROOT="$BATS_FILE_TMPDIR/project"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/state"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/logs"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/rules"
	# Use _TEST_HELPER_DIR from test_helper.bash (resolved at load time, reliable)
	export CLAUDE_PLUGIN_ROOT="$(cd "$_TEST_HELPER_DIR/../.." && pwd)"
	export CLAUDE_SESSION_ID="bats-pipeline-session"
}

# ─── f. Compaction context pipeline ──────────────────────────────────────────
# pre-compact writes context, post-compact-inject restores

@test "pipeline f: compaction survival — pre-compact writes context, post-compact-inject restores" {
	# Write boulder.json with active plan reference
	write_state "boulder.json" \
		'{"active_plan":"/home/user/plans/my-plan.md","plan_name":"my-plan"}'

	# Step 1: run pre-compact — reads state, writes compaction-context.md
	run_hook "pre-compact.sh" '{}'
	assert_success

	local context_file="$CLAUDE_PROJECT_ROOT/.omca/state/compaction-context.md"
	assert [ -f "$context_file" ]

	# Step 2: run post-compact-inject — reads compaction-context.md, emits additionalContext, deletes the file
	run_hook "post-compact-inject.sh" '{"session_id":"bats-pipeline-session"}'
	assert_success

	# Output must contain the post-compaction restore marker
	assert_output --partial "POST-COMPACTION CONTEXT RESTORE"

	# compaction-context.md must be deleted after injection (consumed)
	assert [ ! -f "$context_file" ]
}
