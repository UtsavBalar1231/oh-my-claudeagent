#!/usr/bin/env bats
load '../test_helper'

# The gate no longer guesses from the task's name. Its verdict comes from the slot
# verification-command-recorder.sh writes, so these cases pin slot ordering, session
# scoping, staleness, and the two task names the old verb regex blocked outright.

_write_slot() {
	local command="${1:-just test}" at="${2:-$(date +%s)}" sid="${3:-$CLAUDE_SESSION_ID}"
	jq -n --arg c "$command" --argjson at "$at" --arg s "$sid" \
		'{command: $c, at: $at, session_id: $s, exit_code: null}' \
		> "$CLAUDE_PROJECT_ROOT/.omca/state/last-verification-command.json"
}

_write_evidence() {
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/evidence"
	printf '%s' "{\"entries\":[{\"type\":\"test\",\"command\":\"just test\",\"exit_code\":0,\"output_snippet\":\"10 passed\",\"timestamp\":\"${ts}\"}]}" \
		> "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json"
}

# ─── Reproduced false positives — these task names must complete ─────────────

@test "false positive: 'Write documentation explaining how to fix build errors' completes" {
	run_hook "task-completed-verify.sh" '{"task_description":"Write documentation explaining how to fix build errors"}'
	assert_success
}

@test "false positive: 'Summarize the test strategy discussion' completes" {
	run_hook "task-completed-verify.sh" '{"task_description":"Summarize the test strategy discussion"}'
	assert_success
}

# ─── True-positive control — the case the gate exists for ────────────────────

@test "true positive: a recorded verification with no evidence after it blocks" {
	_write_slot "just test"
	run_hook "task-completed-verify.sh" '{"task_description":"anything at all"}'
	[ "$status" -eq 2 ]
	assert_output --partial 'just test'
	assert_output --partial "logged no evidence after it"
}

@test "true positive: a failing verification with stale evidence still blocks" {
	_write_evidence
	touch -d "2 minutes ago" "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json"
	_write_slot "just test" "$(date +%s)"
	run_hook "task-completed-verify.sh" '{"task_description":"anything"}'
	[ "$status" -eq 2 ]
}

# ─── Slot ordering ───────────────────────────────────────────────────────────

@test "slot ordering: evidence logged after the verification allows" {
	_write_slot "just test" "$(($(date +%s) - 60))"
	_write_evidence
	run_hook "task-completed-verify.sh" '{"task_description":"anything"}'
	assert_success
}

@test "slot ordering: evidence postdating the slot but schema-invalid blocks" {
	_write_slot "just test" "$(($(date +%s) - 60))"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/evidence"
	printf '%s' '{"entries":[{"type":"test"}]}' \
		> "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json"
	run_hook "task-completed-verify.sh" '{"task_description":"anything"}'
	[ "$status" -eq 2 ]
	assert_output --partial "invalid schema"
}

@test "slot ordering: no slot at all allows regardless of evidence" {
	run_hook "task-completed-verify.sh" '{"task_description":"fix the build and verify the tests"}'
	assert_success
}

# ─── Session scoping and staleness ───────────────────────────────────────────

@test "session mismatch: a slot from another session allows" {
	_write_slot "just test" "$(date +%s)" "some-other-session"
	run_hook "task-completed-verify.sh" '{"task_description":"anything"}'
	assert_success
}

@test "staleness: a slot older than 3600s allows" {
	_write_slot "just test" "$(($(date +%s) - 4000))"
	run_hook "task-completed-verify.sh" '{"task_description":"anything"}'
	assert_success
}

@test "staleness: a slot just under 3600s still blocks" {
	_write_slot "just test" "$(($(date +%s) - 3500))"
	run_hook "task-completed-verify.sh" '{"task_description":"anything"}'
	[ "$status" -eq 2 ]
}

# ─── Kill switch ─────────────────────────────────────────────────────────────

@test "kill switch: OMCA_DISABLED_HOOKS listing this gate allows" {
	_write_slot "just test"
	OMCA_DISABLED_HOOKS="task-completed-verify" run_hook "task-completed-verify.sh" '{"task_description":"anything"}'
	assert_success
}

@test "kill switch: OMCA_DISABLED_HOOKS listing a different hook still blocks" {
	_write_slot "just test"
	OMCA_DISABLED_HOOKS="other-hook" run_hook "task-completed-verify.sh" '{"task_description":"anything"}'
	[ "$status" -eq 2 ]
}

# ─── Malformed slot ──────────────────────────────────────────────────────────

@test "malformed slot: unparseable file allows" {
	printf '%s' 'not-json' > "$CLAUDE_PROJECT_ROOT/.omca/state/last-verification-command.json"
	run_hook "task-completed-verify.sh" '{"task_description":"anything"}'
	assert_success
}
