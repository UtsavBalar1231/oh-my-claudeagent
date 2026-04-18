#!/usr/bin/env bats
# Behavioral tests for keyword-detector.sh (UserPromptSubmit hook)

load '../test_helper'

# ---------------------------------------------------------------------------
# Ralph detection
# ---------------------------------------------------------------------------

@test "ralph: detects 'ralph don't stop' and sets ralph-state.json" {
	local payload='{"prompt":"ralph don'\''t stop"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "RALPH MODE DETECTED"
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json" ]
	local status
	status=$(jq -r '.status' "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json")
	assert [ "$status" = "active" ]
}

@test "ralph: state file has expected fields" {
	local payload='{"prompt":"ralph"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json" ]
	local tasks
	tasks=$(jq -r '.tasks' "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json")
	assert [ "$tasks" = "[]" ]
}

# ---------------------------------------------------------------------------
# Ultrawork detection
# ---------------------------------------------------------------------------

@test "ultrawork: detects 'ulw' and creates ultrawork-state.json" {
	local payload='{"prompt":"ulw run in parallel"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "ULTRAWORK MODE DETECTED"
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/ultrawork-state.json" ]
	local status
	status=$(jq -r '.status' "$CLAUDE_PROJECT_ROOT/.omca/state/ultrawork-state.json")
	assert [ "$status" = "active" ]
}

@test "ultrawork: detects 'ultrawork' keyword" {
	local payload='{"prompt":"ultrawork please"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "ULTRAWORK MODE DETECTED"
}

# ---------------------------------------------------------------------------
# Mutual exclusion: ralph wins over ultrawork in same prompt
# ---------------------------------------------------------------------------

@test "mutual exclusion: ralph wins when both appear in same prompt" {
	# Pre-create ultrawork-state.json
	write_state "ultrawork-state.json" '{"status":"active"}'
	local payload='{"prompt":"ralph ultrawork"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	# ralph-state.json must exist
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json" ]
	# ultrawork-state.json must be deleted (ralph actively removes it)
	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/ultrawork-state.json" ]
}

@test "mutual exclusion: only ralph context emitted when both detected" {
	local payload='{"prompt":"ralph ultrawork"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "RALPH MODE DETECTED"
}

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
# Stop-continuation detection
# ---------------------------------------------------------------------------

@test "stop-continuation: detects 'stop continuation'" {
	local payload='{"prompt":"stop continuation"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "STOP CONTINUATION DETECTED"
}

@test "stop-continuation: does not create ralph-state.json" {
	local payload='{"prompt":"ralph stop continuation"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	# ralph detection is suppressed by stop-continuation guard
	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json" ]
}

# ---------------------------------------------------------------------------
# Cancel detection
# ---------------------------------------------------------------------------

@test "cancel: detects 'cancel ralph'" {
	local payload='{"prompt":"cancel ralph"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "CANCEL DETECTED"
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
	local payload='{"prompt":"ralph","agent_id":"sub-123"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	assert_output ""
	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json" ]
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
# Case insensitivity
# ---------------------------------------------------------------------------

@test "case insensitive: RALPH DON'T STOP triggers ralph detection" {
	local payload='{"prompt":"RALPH DON'\''T STOP"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "RALPH MODE DETECTED"
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/ralph-state.json" ]
}

# ---------------------------------------------------------------------------
# Session.json update
# ---------------------------------------------------------------------------

@test "session.json: detectedKeywords updated when session.json exists" {
	write_state "session.json" '{"sessionId":"test","detectedKeywords":[]}'
	local payload='{"prompt":"ralph"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	local keywords
	keywords=$(jq -r '.detectedKeywords[]' "$CLAUDE_PROJECT_ROOT/.omca/state/session.json")
	assert echo "$keywords" | grep -q "ralph"
}

@test "session.json: not created if it does not exist" {
	local payload='{"prompt":"ralph"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/session.json" ]
}

# ---------------------------------------------------------------------------
# Korean text
# ---------------------------------------------------------------------------

@test "korean: '멈추지 마' triggers ralph detection" {
	local payload='{"prompt":"멈추지 마"}'
	run_hook "keyword-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "RALPH MODE DETECTED"
}
