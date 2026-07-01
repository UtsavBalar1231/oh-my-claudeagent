#!/usr/bin/env bats
load '../test_helper'

STARTUP_PAYLOAD='{"hook_event_name":"SessionStart","source":"startup"}'
COMPACT_PAYLOAD='{"hook_event_name":"SessionStart","source":"compact"}'

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

# ─── c3. session-init emits sessionTitle via the boulder_resolve.py shim ──────
# CLAUDE_SESSION_ID is fixed to "bats-test-session" by test_helper.bash setup.

@test "session-init: output contains sessionTitle when this session is bound to a plan" {
	local plan_file="$CLAUDE_PROJECT_ROOT/.omca/state/active-plan.md"
	mkdir -p "$(dirname "$plan_file")"
	printf '# plan\n' > "$plan_file"
	write_state "boulder.json" \
		"{\"plans\":{\"my-awesome-plan\":{\"active_plan\":\"$plan_file\",\"started_at\":\"2026-01-01T00:00:00Z\",\"session_ids\":[\"bats-test-session\"],\"agent\":\"sisyphus\"}},\"bindings\":{\"bats-test-session\":{\"plan_name\":\"my-awesome-plan\"}}}"

	run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success

	local title
	title=$(echo "$output" | jq -r '.hookSpecificOutput.sessionTitle // empty')
	assert [ "$title" = "OMCA: my-awesome-plan" ]
}

@test "session-init: sessionTitle ABSENT when the bound plan's active_plan file is missing (stale)" {
	write_state "boulder.json" \
		'{"plans":{"ghost-plan":{"active_plan":"/tmp/does-not-exist-omca-plan.md","started_at":"2026-01-01T00:00:00Z","session_ids":["bats-test-session"],"agent":"sisyphus"}},"bindings":{"bats-test-session":{"plan_name":"ghost-plan"}}}'

	run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success

	local title
	title=$(echo "$output" | jq -r '.hookSpecificOutput.sessionTitle // empty')
	assert [ "$title" = "" ]
}

@test "session-init: sessionTitle key ABSENT when no boulder.json (unbound shim)" {
	# Ensure no boulder.json exists in state dir — shim resolves to {} for this session
	rm -f "$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json"

	run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success

	local has_title
	has_title=$(echo "$output" | jq 'has("hookSpecificOutput") and (.hookSpecificOutput | has("sessionTitle"))')
	assert [ "$has_title" = "false" ]
}

@test "session-init: existing additionalContext still present when this session is bound to a plan" {
	local plan_file="$CLAUDE_PROJECT_ROOT/.omca/state/active-plan-2.md"
	mkdir -p "$(dirname "$plan_file")"
	printf '# plan\n' > "$plan_file"
	write_state "boulder.json" \
		"{\"plans\":{\"test-plan\":{\"active_plan\":\"$plan_file\",\"started_at\":\"2026-01-01T00:00:00Z\",\"session_ids\":[\"bats-test-session\"],\"agent\":\"sisyphus\"}},\"bindings\":{\"bats-test-session\":{\"plan_name\":\"test-plan\"}}}"

	run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success

	local context
	context=$(get_context)
	[[ "$context" == *"[CURRENT DATE]"* ]]
}

# ─── c4. session-init resets subagent-models.json ─────────────────────────────

@test "session-init: resets subagent-models.json to {}" {
	write_state "subagent-models.json" '{"agent-stale":{"agent_type":"oh-my-claudeagent:executor","model":"Sonnet"}}'

	run_hook "session-init.sh" "$STARTUP_PAYLOAD"
	assert_success

	local content
	content=$(read_state "subagent-models.json")
	assert [ "$content" = "{}" ]
}

# ─── d. pre-compact saves compaction-context.md ───────────────────────────────

@test "pre-compact: creates compaction-context.md with pending tasks block" {
	# Old flat schema, no plan bound to this session — shim resolution falls
	# back to pointer text (the flat schema predates bindings).
	write_state "boulder.json" \
		'{"active_plan":"/tmp/my-plan.md","plan_name":"my-plan"}'

	# pre-compact reads no stdin payload (PreCompact event has no body)
	run_hook "pre-compact.sh" "{}"
	assert_success

	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/compaction-context.md" ]
	local ctx
	ctx=$(cat "$CLAUDE_PROJECT_ROOT/.omca/state/compaction-context.md")
	[[ "$ctx" == *"Remaining tasks"* ]]
}

# ─── e. post-compact-inject restores saved context ────────────────────────────

@test "post-compact-inject: output contains saved compaction-context.md content" {
	write_state "compaction-context.md" \
		"$(printf '## Active Plan\nPlan my-plan is active. The boulder never stops.\n## Pending Tasks\nTask alpha is pending.')"

	run_hook "post-compact-inject.sh" "$COMPACT_PAYLOAD"
	assert_success
	local context
	context=$(get_context)
	[[ "$context" == *"[POST-COMPACTION CONTEXT RESTORE]"* ]]
	[[ "$context" == *"Plan my-plan is active"* ]]
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
