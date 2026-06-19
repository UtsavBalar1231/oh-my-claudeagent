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

# ─── c. session-init output is bounded — no XML orchestration tags ───────────

@test "session-init: output contains no XML orchestration tags" {
	run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success
	local context
	context=$(get_context)
	# The hook emits only date + session-id + state-dir. Orchestration body lives
	# in output-styles/omca-default.md — it must never bleed into hook output.
	[[ "$context" != *"<operating_principles>"* ]]
	[[ "$context" != *"<agent_catalog>"* ]]
	[[ "$context" != *"<delegation>"* ]]
	[[ "$context" == *"[CURRENT DATE]"* ]]
}

# ─── c2. output-styles/omca-default.md carries the minimal-code creed ─────────

@test "output-styles/omca-default.md: carries the minimal-code coding discipline" {
	# The always-on output style is deliberately lean: it carries the minimal-code
	# creed, while orchestration routing/verification detail lives in the omca-setup
	# block and the specialist agents (so it does not weigh on every turn).
	local style_file
	style_file="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/output-styles/omca-default.md"
	assert [ -f "$style_file" ]
	grep -q "Write the minimum that solves the problem" "$style_file"
}

# ─── c3. session-init emits sessionTitle when boulder.json is active ──────────

@test "session-init: output contains sessionTitle when boulder.json has plan_name" {
	write_state "boulder.json" \
		'{"active_plan":"/tmp/my-plan.md","plan_name":"my-awesome-plan","session_ids":["sess-001"],"agent":"sisyphus"}'

	run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success

	local title
	title=$(echo "$output" | jq -r '.hookSpecificOutput.sessionTitle // empty')
	assert [ "$title" = "OMCA: my-awesome-plan" ]
}

@test "session-init: sessionTitle key ABSENT when no boulder.json" {
	# Ensure no boulder.json exists in state dir
	rm -f "$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json"

	run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success

	local has_title
	has_title=$(echo "$output" | jq 'has("hookSpecificOutput") and (.hookSpecificOutput | has("sessionTitle"))')
	assert [ "$has_title" = "false" ]
}

@test "session-init: existing additionalContext still present when boulder.json active" {
	write_state "boulder.json" \
		'{"active_plan":"/tmp/plan.md","plan_name":"test-plan","session_ids":["s1"],"agent":"sisyphus"}'

	run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success

	local context
	context=$(get_context)
	[[ "$context" == *"[CURRENT DATE]"* ]]
}

@test "session-init: sweeps stale subagents.json .active phantoms, keeps fresh ones" {
	local now old fresh
	now=$(date +%s)
	old=$((now - 7200))
	fresh=$((now - 60))
	write_state "subagents.json" \
		"{\"active\":[{\"id\":\"old\",\"type\":\"x\",\"status\":\"running\",\"started_epoch\":${old}},{\"id\":\"fresh\",\"type\":\"y\",\"status\":\"running\",\"started_epoch\":${fresh}}],\"completed\":[]}"

	run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success

	local ids
	ids=$(jq -c '[.active[].id]' "$CLAUDE_PROJECT_ROOT/.omca/state/subagents.json")
	[[ "$ids" == '["fresh"]' ]]
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
