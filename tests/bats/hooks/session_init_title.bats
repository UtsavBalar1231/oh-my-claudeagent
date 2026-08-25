#!/usr/bin/env bats
# session-init.sh: sessionTitle deference and the FileChanged watch list.
# A title the user set via --name or /rename comes back in the SessionStart
# payload as session_title; emitting sessionTitle over it discards their name.

load '../test_helper'

# Register a bound, incomplete plan for the session id the helper exports, so the
# strict resolver in session-init.sh finds it and the GC pass keeps it.
bind_plan() {
	local plan="$BATS_TEST_TMPDIR/my-plan.md"
	printf -- '- [ ] 1. do the thing\n' > "$plan"
	write_state "boulder.json" "$(jq -n --arg p "$plan" '{
		plans: {"my-plan": {active_plan: $p, started_at: "2026-08-01T00:00:00Z", session_ids: ["bats-test-session"], agent: "sisyphus"}},
		bindings: {"bats-test-session": {plan_name: "my-plan", bound_at: 1786024296}}
	}')"
}

@test "session-init: a bound plan with no user title sets sessionTitle" {
	bind_plan
	run_hook "session-init.sh" '{"hook_event_name":"SessionStart","source":"startup","session_id":"bats-test-session"}'
	assert_success
	[[ "$(jq -r '.hookSpecificOutput.sessionTitle' <<< "$output")" == "OMCA: my-plan" ]]
}

@test "session-init: an empty session_title still lets the plan name through" {
	bind_plan
	run_hook "session-init.sh" '{"hook_event_name":"SessionStart","source":"startup","session_id":"bats-test-session","session_title":""}'
	assert_success
	[[ "$(jq -r '.hookSpecificOutput.sessionTitle' <<< "$output")" == "OMCA: my-plan" ]]
}

@test "session-init: a user-set session_title suppresses the key entirely" {
	bind_plan
	run_hook "session-init.sh" '{"hook_event_name":"SessionStart","source":"startup","session_id":"bats-test-session","session_title":"my own name"}'
	assert_success
	[[ "$(jq -r '.hookSpecificOutput | has("sessionTitle")' <<< "$output")" == "false" ]]
}

@test "session-init: an unbound session emits no sessionTitle key" {
	run_hook "session-init.sh" '{"hook_event_name":"SessionStart","source":"startup","session_id":"bats-test-session"}'
	assert_success
	[[ "$(jq -r '.hookSpecificOutput | has("sessionTitle")' <<< "$output")" == "false" ]]
}

@test "session-init: watchPaths carries the evidence ledger and the plan registry" {
	run_hook "session-init.sh" '{"hook_event_name":"SessionStart","source":"startup","session_id":"bats-test-session"}'
	assert_success
	local paths
	paths=$(jq -r '.hookSpecificOutput.watchPaths[]' <<< "$output")
	[[ "$paths" == *"$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json"* ]]
	[[ "$paths" == *"$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json"* ]]
}

@test "session-init: watchPaths is present on the titled branch too" {
	bind_plan
	run_hook "session-init.sh" '{"hook_event_name":"SessionStart","source":"startup","session_id":"bats-test-session"}'
	assert_success
	[[ "$(jq -r '.hookSpecificOutput.watchPaths | length' <<< "$output")" == "2" ]]
}
