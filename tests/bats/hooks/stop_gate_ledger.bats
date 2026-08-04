#!/usr/bin/env bats
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

_write_complete_plan() {
	cat > "$1" <<'EOF'
# My Plan

- [x] 1. First task
- [x] 2. Second task
EOF
}

_write_boulder() {
	jq -n --arg plan "$1" --arg name "test-plan" --arg sid "${CLAUDE_SESSION_ID}" \
		'{"plans":{($name):{"active_plan":$plan,"started_at":"2026-01-01T00:00:00Z","session_ids":[$sid],"agent":"sisyphus"}},"bindings":{($sid):{"plan_name":$name,"bound_at":1}}}' \
		> "${CLAUDE_PROJECT_ROOT}/.omca/state/boulder.json"
}

_claim_payload() {
	jq -n --arg t "$1" '{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":$t}'
}

@test "stop ledger: a resetting gate does not refund a blocking sibling's budget" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local decisions="" i
	for i in 1 2 3 4 5 6 7; do
		run_hook "drift-guard.sh" "$(_claim_payload 'All done, implemented and fixed.')"
		assert_output '{}'
		run_hook "final-verification-evidence.sh" '{}'
		decisions+="$(jq -r '.decision // "allow"' <<< "$output") "
	done

	assert_equal "$decisions" "block block block block block allow allow "
}

@test "stop ledger: a gate's own reset clears only its own key" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local i
	for i in 1 2 3; do
		run_hook "final-verification-evidence.sh" '{}'
	done

	echo "it.only('t', () => {})" >> a.js
	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_equal "$(jq -r '.decision // "allow"' <<< "$output")" "block"

	git checkout -q -- a.js
	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_output '{}'

	run jq -r '."drift-guard" // "absent"' "${CLAUDE_PROJECT_ROOT}/.omca/state/stop-blocks.json"
	assert_output 'absent'
	run jq -r '."final-verification-evidence"' "${CLAUDE_PROJECT_ROOT}/.omca/state/stop-blocks.json"
	assert_output '3'
}
