#!/usr/bin/env bats
# Behavioral tests for slash-command-mode-detector.sh (UserPromptExpansion hook)

load '../test_helper'

# ---------------------------------------------------------------------------
# ralph slash command
# ---------------------------------------------------------------------------

@test "ralph: /oh-my-claudeagent:ralph activates ralph mode and emits banner" {
	local payload='{"command_name":"oh-my-claudeagent:ralph","command_args":[],"command_source":"plugin","expansion_type":"slash_command","prompt":""}'
	run_hook "slash-command-mode-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "RALPH MODE ACTIVATED"
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json" ]
	local stored_mode
	stored_mode=$(jq -r '.ralph.session_id // ""' "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json")
	assert [ -n "$stored_mode" ]
}

# ---------------------------------------------------------------------------
# ultrawork slash command
# ---------------------------------------------------------------------------

@test "ultrawork: /oh-my-claudeagent:ultrawork activates ultrawork mode and emits banner" {
	local payload='{"command_name":"oh-my-claudeagent:ultrawork","command_args":[],"command_source":"plugin","expansion_type":"slash_command","prompt":""}'
	run_hook "slash-command-mode-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "ULTRAWORK MODE ACTIVATED"
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json" ]
	local stored_mode
	stored_mode=$(jq -r '.ultrawork.session_id // ""' "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json")
	assert [ -n "$stored_mode" ]
}

# ---------------------------------------------------------------------------
# ulw-loop alias
# ---------------------------------------------------------------------------

@test "ulw-loop: /oh-my-claudeagent:ulw-loop activates ultrawork mode (alias)" {
	local payload='{"command_name":"oh-my-claudeagent:ulw-loop","command_args":[],"command_source":"plugin","expansion_type":"slash_command","prompt":""}'
	run_hook "slash-command-mode-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "ULTRAWORK MODE ACTIVATED"
	# Stored under the canonical 'ultrawork' key
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json" ]
	local stored_mode
	stored_mode=$(jq -r '.ultrawork.session_id // ""' "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json")
	assert [ -n "$stored_mode" ]
}

# ---------------------------------------------------------------------------
# handoff slash command
# ---------------------------------------------------------------------------

@test "handoff: /oh-my-claudeagent:handoff activates handoff mode and emits banner" {
	local payload='{"command_name":"oh-my-claudeagent:handoff","command_args":[],"command_source":"plugin","expansion_type":"slash_command","prompt":""}'
	run_hook "slash-command-mode-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "HANDOFF MODE ACTIVATED"
	local stored_mode
	stored_mode=$(jq -r '.handoff.session_id // ""' "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json")
	assert [ -n "$stored_mode" ]
}

# ---------------------------------------------------------------------------
# stop-continuation slash command
# ---------------------------------------------------------------------------

@test "stop-continuation: /oh-my-claudeagent:stop-continuation activates mode and emits banner" {
	local payload='{"command_name":"oh-my-claudeagent:stop-continuation","command_args":[],"command_source":"plugin","expansion_type":"slash_command","prompt":""}'
	run_hook "slash-command-mode-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "STOP CONTINUATION ACTIVATED"
	local stored_mode
	stored_mode=$(jq -r '."stop-continuation".session_id // ""' "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json")
	assert [ -n "$stored_mode" ]
}

# ---------------------------------------------------------------------------
# Non-OMCA slash command — no activation
# ---------------------------------------------------------------------------

@test "non-omca: /recap produces no mode activation and exits 0" {
	local payload='{"command_name":"recap","command_args":[],"command_source":"builtin","expansion_type":"slash_command","prompt":""}'
	run_hook "slash-command-mode-detector.sh" "$payload"
	assert_success
	assert_output ""
	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json" ]
}

@test "non-omca: /code-review:code-review produces no mode activation and exits 0" {
	local payload='{"command_name":"code-review:code-review","command_args":[],"command_source":"plugin","expansion_type":"slash_command","prompt":""}'
	run_hook "slash-command-mode-detector.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Non-mode-triggering OMCA command — no activation
# ---------------------------------------------------------------------------

@test "non-mode omca: /oh-my-claudeagent:plan produces no mode activation and exits 0" {
	local payload='{"command_name":"oh-my-claudeagent:plan","command_args":[],"command_source":"plugin","expansion_type":"slash_command","prompt":""}'
	run_hook "slash-command-mode-detector.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# Re-announce suppression (same session)
# ---------------------------------------------------------------------------

@test "echo-suppression: same-session re-fire does NOT re-announce ralph" {
	write_state "active-modes.json" \
		"{\"ralph\":{\"detected_at\":1000000,\"session_id\":\"${CLAUDE_SESSION_ID}\"}}"
	local payload='{"command_name":"oh-my-claudeagent:ralph","command_args":[],"command_source":"plugin","expansion_type":"slash_command","prompt":""}'
	run_hook "slash-command-mode-detector.sh" "$payload"
	assert_success
	assert_output ""
}

@test "echo-suppression: cross-session re-announces ralph on new session" {
	write_state "active-modes.json" \
		'{"ralph":{"detected_at":1000000,"session_id":"old-session-XYZ"}}'
	local payload='{"command_name":"oh-my-claudeagent:ralph","command_args":[],"command_source":"plugin","expansion_type":"slash_command","prompt":""}'
	run_hook "slash-command-mode-detector.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "RALPH MODE ACTIVATED"
	local stored_sid
	stored_sid=$(jq -r '.ralph.session_id // ""' "$CLAUDE_PROJECT_ROOT/.omca/state/active-modes.json")
	assert [ "$stored_sid" = "$CLAUDE_SESSION_ID" ]
}

# ---------------------------------------------------------------------------
# Empty / missing command_name
# ---------------------------------------------------------------------------

@test "empty command_name: exits 0 with no output" {
	local payload='{"command_name":"","expansion_type":"slash_command","prompt":""}'
	run_hook "slash-command-mode-detector.sh" "$payload"
	assert_success
	assert_output ""
}

@test "missing command_name field: exits 0 with no output" {
	local payload='{"expansion_type":"slash_command","prompt":"fix something"}'
	run_hook "slash-command-mode-detector.sh" "$payload"
	assert_success
	assert_output ""
}
