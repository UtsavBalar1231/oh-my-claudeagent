#!/usr/bin/env bats
# session-init.sh: new-state-file session reset + shape-agnostic error-counts
# migration. Behavioral coverage for the Phase-4 wiring: plan-continuation.json,
# tool-loop-window.json, delegation-counter.json must not survive a SessionStart,
# and the legacy Task:delegate_error migration must merge correctly regardless
# of whether either side is bare-int or object-shaped.

load '../test_helper'

@test "session-init: deletes plan-continuation.json, tool-loop-window.json, delegation-counter.json on SessionStart" {
	write_state "plan-continuation.json" '{"consecutive_blocks": 3, "last_block_at": 100, "last_unchecked_count": 2, "same_count_run": 1, "stagnated": false}'
	write_state "tool-loop-window.json" '{"signature": "abc123", "count": 2}'
	write_state "delegation-counter.json" '{"direct_calls": 2, "silenced": false}'

	run_hook "session-init.sh" "{}"
	assert_success

	[ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/plan-continuation.json" ]
	[ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/tool-loop-window.json" ]
	[ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/delegation-counter.json" ]
}

@test "session-init: SessionStart with none of the three files present is a no-op (no error)" {
	run_hook "session-init.sh" "{}"
	assert_success
}

@test "session-init: a fork leaves the parent's shared state untouched" {
	write_state "session.json" '{"sessionId":"parent-sid","subagents":[]}'
	write_state "injected-context-dirs.json" '{"/parent/dir|100":"true"}'
	write_state "subagent-models.json" '{"agent-parent":{"agent_type":"oh-my-claudeagent:executor","model":"Sonnet"}}'
	write_state "plan-continuation.json" '{"consecutive_blocks":2}'
	write_state "tool-loop-window.json" '{"signature":"abc123","count":2}'
	write_state "delegation-counter.json" '{"direct_calls":2,"silenced":false}'

	run_hook "session-init.sh" '{"hook_event_name":"SessionStart","source":"fork","session_id":"fork-sid"}'
	assert_success

	[[ "$(jq -r '.sessionId' <<< "$(read_state 'session.json')")" == "parent-sid" ]]
	[[ "$(jq -r 'has("/parent/dir|100")' <<< "$(read_state 'injected-context-dirs.json')")" == "true" ]]
	[[ "$(jq -r 'has("agent-parent")' <<< "$(read_state 'subagent-models.json')")" == "true" ]]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/plan-continuation.json" ]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/tool-loop-window.json" ]
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/delegation-counter.json" ]
}

@test "session-init: a startup still claims session.json and resets the per-session files" {
	write_state "session.json" '{"sessionId":"previous-sid"}'
	write_state "injected-context-dirs.json" '{"/stale/dir|100":"true"}'
	write_state "subagent-models.json" '{"agent-stale":{"agent_type":"oh-my-claudeagent:executor","model":"Sonnet"}}'
	write_state "tool-loop-window.json" '{"signature":"abc123","count":2}'

	run_hook "session-init.sh" '{"hook_event_name":"SessionStart","source":"startup","session_id":"new-sid"}'
	assert_success

	[[ "$(jq -r '.sessionId' <<< "$(read_state 'session.json')")" != "previous-sid" ]]
	[[ "$(read_state 'injected-context-dirs.json')" == "{}" ]]
	[[ "$(read_state 'subagent-models.json')" == "{}" ]]
	assert [ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/tool-loop-window.json" ]
}

@test "session-init: error-counts migration merges bare-int legacy into bare-int target" {
	write_state "error-counts.json" '{"Task:delegate_error": 2, "Agent:delegate_error": 1}'

	run_hook "session-init.sh" "{}"
	assert_success

	local result
	result=$(read_state "error-counts.json")
	[[ "$(jq -r 'has("Task:delegate_error")' <<< "$result")" == "false" ]]
	[[ "$(jq -r '."Agent:delegate_error"' <<< "$result")" == "3" ]]
}

@test "session-init: error-counts migration merges bare-int legacy into object-shaped target" {
	write_state "error-counts.json" '{"Task:delegate_error": 2, "Agent:delegate_error": {"count": 1, "last_failure_at": 500, "last_errors": ["boom"]}}'

	run_hook "session-init.sh" "{}"
	assert_success

	local result
	result=$(read_state "error-counts.json")
	[[ "$(jq -r 'has("Task:delegate_error")' <<< "$result")" == "false" ]]
	[[ "$(jq -r '."Agent:delegate_error".count' <<< "$result")" == "3" ]]
	[[ "$(jq -r '."Agent:delegate_error".last_failure_at' <<< "$result")" == "500" ]]
	[[ "$(jq -r '."Agent:delegate_error".last_errors | length' <<< "$result")" == "1" ]]
}

@test "session-init: error-counts migration merges object-shaped legacy into bare-int target" {
	write_state "error-counts.json" '{"Task:delegate_error": {"count": 4, "last_failure_at": 700, "last_errors": ["oops"]}, "Agent:delegate_error": 1}'

	run_hook "session-init.sh" "{}"
	assert_success

	local result
	result=$(read_state "error-counts.json")
	[[ "$(jq -r 'has("Task:delegate_error")' <<< "$result")" == "false" ]]
	[[ "$(jq -r '."Agent:delegate_error".count' <<< "$result")" == "5" ]]
	[[ "$(jq -r '."Agent:delegate_error".last_failure_at' <<< "$result")" == "700" ]]
}

@test "session-init: error-counts migration is idempotent when Task:delegate_error is absent" {
	write_state "error-counts.json" '{"Agent:delegate_error": 3}'

	run_hook "session-init.sh" "{}"
	assert_success

	local result
	result=$(read_state "error-counts.json")
	[[ "$(jq -r '."Agent:delegate_error"' <<< "$result")" == "3" ]]
}

# ── venv sync must not consume the SessionStart time budget ───────────────────
# Regression: `uv sync` reaches the network and ran inline, so a slow link killed
# the hook at its 5s cap and lost the date block, sessionTitle, session.json and
# every state reset below it. The sync is now detached and runs after the JSON.

@test "session-init: a slow uv sync neither delays nor truncates the hook output" {
	local fake="$BATS_TEST_TMPDIR/fakeplugin"
	mkdir -p "$fake/servers"
	printf '[project]\nname = "x"\n' > "$fake/servers/pyproject.toml"
	printf '#!/bin/sh\nsleep 30\n' > "$fake/uv"
	chmod +x "$fake/uv"

	local started ended
	started=$(date +%s)
	CLAUDE_PLUGIN_DATA="$BATS_TEST_TMPDIR/plugindata" \
		PATH="$fake:$PATH" \
		run timeout 5 bash "$CLAUDE_PLUGIN_ROOT/scripts/session-init.sh" <<< '{"session_id":"sess-slow","source":"startup"}'
	ended=$(date +%s)

	assert_success
	[ "$(( ended - started ))" -lt 5 ]
	echo "$output" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' >/dev/null
	echo "$output" | jq -e '.hookSpecificOutput.additionalContext | test("CURRENT DATE")' >/dev/null
	assert [ -f "$CLAUDE_PROJECT_ROOT/.omca/state/session.json" ]
}

# ── hook-errors.jsonl gets a reader ───────────────────────────────────────────
# Regression: the log was append-only with nothing reading it, so a permanently
# broken hook stayed invisible. One line, only for what is new, silent otherwise.

_log_hook_error() {
	jq -nc --arg h "$1" '{timestamp:"2026-08-04T00:00:00Z",level:"error",hook:$h,message:"boom"}' \
		>> "$CLAUDE_PROJECT_ROOT/.omca/logs/hook-errors.jsonl"
}

@test "session-init: reports the distinct hooks that errored since the last session start" {
	_log_hook_error "drift-guard.sh"
	_log_hook_error "drift-guard.sh"
	_log_hook_error "write-guard.sh"

	run_hook "session-init.sh" '{"session_id":"sess-a","source":"startup"}'
	assert_success
	local ctx
	ctx=$(get_context)
	[[ "$ctx" == *"[HOOK ERRORS] 2 hook(s)"* ]]
	[[ "$ctx" == *"drift-guard.sh"* ]]
	[[ "$ctx" == *"write-guard.sh"* ]]
}

@test "session-init: says nothing about hook errors when none are new" {
	_log_hook_error "drift-guard.sh"
	run_hook "session-init.sh" '{"session_id":"sess-a","source":"startup"}'
	assert_success

	run_hook "session-init.sh" '{"session_id":"sess-b","source":"startup"}'
	assert_success
	[[ "$(get_context)" != *"HOOK ERRORS"* ]]
}

@test "session-init: says nothing about hook errors when the log is absent" {
	run_hook "session-init.sh" '{"session_id":"sess-a","source":"startup"}'
	assert_success
	[[ "$(get_context)" != *"HOOK ERRORS"* ]]
}

@test "session-init: a rotated error log is re-read from the top, not skipped" {
	local i
	for i in 1 2 3 4 5; do _log_hook_error "drift-guard.sh"; done
	run_hook "session-init.sh" '{"session_id":"sess-a","source":"startup"}'

	: > "$CLAUDE_PROJECT_ROOT/.omca/logs/hook-errors.jsonl"
	_log_hook_error "post-edit.sh"
	run_hook "session-init.sh" '{"session_id":"sess-b","source":"startup"}'
	assert_success
	[[ "$(get_context)" == *"post-edit.sh"* ]]
}
