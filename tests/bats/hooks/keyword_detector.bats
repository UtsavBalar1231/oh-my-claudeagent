#!/usr/bin/env bats
# Behavioral tests for keyword-detector.sh (UserPromptSubmit hook)

load '../test_helper'

# ---------------------------------------------------------------------------
# Handoff detection
# ---------------------------------------------------------------------------

@test "handoff: detects 'handoff please'" {
	local payload='{"prompt":"handoff please"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "HANDOFF MODE DETECTED"
}

# ---------------------------------------------------------------------------
# Negative: no keyword
# ---------------------------------------------------------------------------

@test "no keyword: non-matching prompt produces empty output and exits 0" {
	local payload='{"prompt":"fix the login bug"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Subagent skip
# ---------------------------------------------------------------------------

@test "subagent skip: agent_id present causes exit 0 with no output" {
	local payload='{"prompt":"handoff please","agent_id":"sub-123"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Empty prompt
# ---------------------------------------------------------------------------

@test "empty prompt: exits 0 with no output" {
	local payload='{"prompt":""}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Session.json update
# ---------------------------------------------------------------------------

@test "session.json: detectedKeywords updated when session.json exists" {
	write_state "session.json" '{"sessionId":"test","detectedKeywords":[]}'
	local payload='{"prompt":"handoff please"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	local keywords
	keywords=$(jq -r '.detectedKeywords[]' "$CLAUDE_PROJECT_ROOT/.omca/state/session.json")
	assert echo "$keywords" | grep -q "handoff"
}

@test "session.json: not created if it does not exist" {
	local payload='{"prompt":"handoff please"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/session.json" ]
}

# ---------------------------------------------------------------------------
# Echo-suppression: active-modes.json guard (C-10)
# ---------------------------------------------------------------------------

@test "echo-suppression case 1: first-fire announces and writes active-modes.json" {
	# No active-modes.json present — genuine first-fire
	local payload='{"prompt":"handoff please","session_id":"test-session-A"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "HANDOFF MODE DETECTED"
	# Marker must be written
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json" ]
	local stored_sid
	stored_sid=$(jq -r '.handoff.session_id // ""' "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json")
	assert [ -n "$stored_sid" ]
}

@test "echo-suppression case 2: same-session re-fire does NOT re-announce" {
	# Pre-populate active-modes.json with handoff from the current bats session
	write_state "active-modes.json" \
		"{\"handoff\":{\"detected_at\":1000000,\"session_id\":\"${CLAUDE_SESSION_ID}\"}}"
	local payload='{"prompt":"handoff please"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	# No announcement should be emitted
	assert_output ""
}

@test "echo-suppression case 3: cross-session reset re-announces on new session" {
	# Pre-populate with a DIFFERENT session_id
	write_state "active-modes.json" \
		'{"handoff":{"detected_at":1000000,"session_id":"old-session-XYZ"}}'
	# CLAUDE_SESSION_ID is set to "bats-test-session" by test_helper setup()
	local payload='{"prompt":"handoff please"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "HANDOFF MODE DETECTED"
	# Marker must be updated with current session
	local stored_sid
	stored_sid=$(jq -r '.handoff.session_id // ""' "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json")
	assert [ "$stored_sid" = "$CLAUDE_SESSION_ID" ]
}

# ---------------------------------------------------------------------------
# Task-notification relay guard
# ---------------------------------------------------------------------------

@test "task-notification: prompt containing <task-notification> tag does NOT activate any mode" {
	# Simulates a background-agent result relayed as a type="user" turn whose content
	# is a <task-notification> block. Without the guard these keywords would have
	# activated modes and polluted active-modes.json.
	local notif_prompt
	notif_prompt='<task-notification><result>Agent completed: handoff plan hephaestus</result></task-notification>'
	local payload
	payload=$(jq -n --arg p "$notif_prompt" '{"prompt":$p}')
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	assert_output ""
	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json" ]
}

@test "task-notification: genuine 'handoff please' prompt still triggers handoff detection" {
	# Regression guard: the task-notification guard must not suppress real user prompts.
	local payload='{"prompt":"handoff please"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "HANDOFF MODE DETECTED"
}
