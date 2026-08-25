#!/usr/bin/env bats
# Stop-gate behavior when the session ends a turn with background work in
# flight. Only plan-continuation-guard treats that as "paused, not stalled";
# drift-guard keeps blocking, because a completion claim made while executors
# are still writing files is exactly the drift it exists to catch.

load '../test_helper'

setup() {
	export CLAUDE_PROJECT_ROOT="$BATS_TEST_TMPDIR/project"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/state" "$CLAUDE_PROJECT_ROOT/.omca/logs"
	export CLAUDE_PLUGIN_ROOT="$(cd "$_TEST_HELPER_DIR/../.." && pwd)"
	export CLAUDE_SESSION_ID="bats-test-session"

	cd "$CLAUDE_PROJECT_ROOT"
	git init -q
	git config user.email "test@example.com"
	git config user.name "Test"
	echo "seed" > a.js
	git add -A
	git commit -qm seed
}

_write_unchecked_plan() {
	cat > "$1" <<'EOF'
# My Plan

- [x] 1. First task
- [ ] 2. Second task not done
EOF
}

_write_boulder() {
	jq -n --arg plan "$1" --arg name "test-plan" --arg sid "${CLAUDE_SESSION_ID}" --argjson bound_at "$(date +%s)" \
		'{"plans":{($name):{"active_plan":$plan,"started_at":"2026-01-01T00:00:00Z","session_ids":[$sid],"agent":"sisyphus"}},"bindings":{($sid):{"plan_name":$name,"bound_at":$bound_at}}}' \
		> "${CLAUDE_PROJECT_ROOT}/.omca/state/boulder.json"
}

# Stop payload carrying an arbitrary background_tasks array (JSON text).
_payload_with_tasks() {
	jq -n --argjson tasks "$1" --arg t "${2:-}" \
		'{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":$t,"background_tasks":$tasks,"session_crons":[]}'
}

_decision() {
	jq -r '.decision // "allow"' <<< "$output"
}

_running_subagent='[{"id":"task-001","type":"subagent","status":"running","description":"executor wave","agent_type":"oh-my-claudeagent:executor"}]'
_finished_subagent='[{"id":"task-001","type":"subagent","status":"completed","description":"executor wave","agent_type":"oh-my-claudeagent:executor"}]'

@test "plan-continuation-guard: blocks when tasks remain and nothing is running" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" "$(_payload_with_tasks '[]')"
	assert_success
	assert_equal "$(_decision)" "block"
}

@test "plan-continuation-guard: opens when a background task is running" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" "$(_payload_with_tasks "${_running_subagent}")"
	assert_success
	assert_output '{}'
	[ ! -f "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json" ]
}

@test "plan-continuation-guard: a finished background task still blocks" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" "$(_payload_with_tasks "${_finished_subagent}")"
	assert_success
	assert_equal "$(_decision)" "block"
}

@test "plan-continuation-guard: the open path clears this gate's ledger key only" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"
	jq -n '{"plan-continuation-guard":3,"drift-guard":2}' \
		> "${CLAUDE_PROJECT_ROOT}/.omca/state/stop-blocks.json"

	run_hook "plan-continuation-guard.sh" "$(_payload_with_tasks "${_running_subagent}")"
	assert_output '{}'

	run jq -r '."plan-continuation-guard" // "absent"' "${CLAUDE_PROJECT_ROOT}/.omca/state/stop-blocks.json"
	assert_output 'absent'
	run jq -r '."drift-guard"' "${CLAUDE_PROJECT_ROOT}/.omca/state/stop-blocks.json"
	assert_output '2'
}

@test "drift-guard: still blocks a completion claim while a task is running" {
	echo "it.only('t', () => {})" >> "${CLAUDE_PROJECT_ROOT}/a.js"

	run_hook "drift-guard.sh" "$(_payload_with_tasks "${_running_subagent}" 'All done, implemented and fixed.')"
	assert_success
	assert_equal "$(_decision)" "block"
}
