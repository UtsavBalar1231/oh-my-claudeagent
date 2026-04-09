#!/usr/bin/env bats
load '../test_helper'

STARTUP_PAYLOAD='{"hook_event_name":"SessionStart","source":"startup"}'
COMPACT_PAYLOAD='{"hook_event_name":"SessionStart","source":"compact"}'
STOPFAILURE_PAYLOAD='{"session_id":"test-session","hook_event_name":"StopFailure","error":"rate_limit","error_details":"429 Too Many Requests","last_assistant_message":"API Error: Rate limit reached"}'

# ─── a. session-init creates session.json ────────────────────────────────────

@test "session-init: creates session.json with sessionId field" {
	run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/session.json" ]
	local session_id
	session_id=$(cat "$CLAUDE_PROJECT_ROOT/.omca/state/session.json" | jq -r '.sessionId')
	assert [ -n "$session_id" ]
}

# ─── b. session-init injects current date ─────────────────────────────────────

@test "session-init: output contains [CURRENT DATE] block" {
	run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success
	local context
	context=$(get_context)
	[[ "$context" == *"[CURRENT DATE]"* ]]
}

# ─── c. session-init skips full template when OMCA is configured ──────────────

@test "session-init: skips full template when ~/.claude/CLAUDE.md has omca-setup" {
	# Create a mock HOME with a CLAUDE.md containing the omca-setup marker
	local mock_home="$BATS_TEST_TMPDIR/mock-home"
	mkdir -p "$mock_home/.claude"
	printf '%s\n' "--- omca-setup" "plugin: oh-my-claudeagent" "--- /omca-setup ---" \
		> "$mock_home/.claude/CLAUDE.md"

	HOME="$mock_home" run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success
	local context
	context=$(get_context)
	# Configured path emits short context — the full behavioral template MUST NOT
	# leak into the output. Key two canaries to orthogonal template signals so a
	# future template rewrite cannot silently rot both at once.
	[[ "$context" != *"<agent_catalog>"* ]]
	[[ "$context" != *"Treat Claude Code as the platform owner"* ]]
	# But it should still have the date and session info
	[[ "$context" == *"[CURRENT DATE]"* ]]
}

# ─── d. pre-compact saves compaction-context.md ───────────────────────────────

@test "pre-compact: creates compaction-context.md with ralph state info" {
	write_state "ralph-state.json" \
		'{"status":"active","tasks":[{"id":"1","status":"pending"}]}'
	write_state "boulder.json" \
		'{"active_plan":"/tmp/my-plan.md","plan_name":"my-plan"}'

	# pre-compact reads no stdin payload (PreCompact event has no body)
	run_hook "pre-compact.sh" "{}"
	assert_success

	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/compaction-context.md" ]
	local ctx
	ctx=$(cat "$CLAUDE_PROJECT_ROOT/.omca/state/compaction-context.md")
	[[ "$ctx" == *"Ralph mode is ACTIVE"* ]]
}

# ─── e. post-compact-inject restores saved context ────────────────────────────

@test "post-compact-inject: output contains saved compaction-context.md content" {
	write_state "compaction-context.md" \
		"$(printf '## Active Mode\nRalph mode is ACTIVE. The boulder never stops.\n## Pending Tasks\nTask alpha is pending.')"

	run_hook "post-compact-inject.sh" "$COMPACT_PAYLOAD"
	assert_success
	local context
	context=$(get_context)
	[[ "$context" == *"[POST-COMPACTION CONTEXT RESTORE]"* ]]
	[[ "$context" == *"Ralph mode is ACTIVE"* ]]
}

# ─── f. post-compact-inject deletes compaction-context.md after injection ─────

@test "post-compact-inject: deletes compaction-context.md after successful injection" {
	write_state "compaction-context.md" \
		"$(printf '## Active Mode\nSome state content\n')"

	run_hook "post-compact-inject.sh" "$COMPACT_PAYLOAD"
	assert_success
	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/compaction-context.md" ]
}

# ─── g. post-compact-inject is idempotent (no context file) ───────────────────

@test "post-compact-inject: exits 0 with no output when compaction-context.md absent" {
	# No compaction-context.md written — script should exit cleanly
	run_hook "post-compact-inject.sh" "$COMPACT_PAYLOAD"
	assert_success
	assert_output ""
}

# ─── h. stop-failure-handler logs to stop-failures.jsonl ─────────────────────

@test "stop-failure-handler: logs event to stop-failures.jsonl" {
	run_hook "stop-failure-handler.sh" "$STOPFAILURE_PAYLOAD"
	assert_success

	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/stop-failures.jsonl"
	assert [ -f "$log_file" ]

	local event
	event=$(tail -1 "$log_file" | jq -r '.event')
	assert [ "$event" = "stop_failure" ]

	local error
	error=$(tail -1 "$log_file" | jq -r '.error')
	assert [ "$error" = "rate_limit" ]
}
