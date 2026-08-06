#!/usr/bin/env bats
load '../test_helper'

TASK_BASIC='{"task_description":"status report only"}'
TASK_VERIFY='{"task_description":"all tests pass — implement and verify the build"}'

_write_slot() {
	local at="${1:-$(date +%s)}"
	jq -n --argjson at "$at" --arg s "$CLAUDE_SESSION_ID" \
		'{command: "just test", at: $at, session_id: $s, exit_code: null}' \
		> "$CLAUDE_PROJECT_ROOT/.omca/state/last-verification-command.json"
}

_write_fresh_evidence() {
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/evidence"
	printf '%s' "{\"entries\":[{\"type\":\"test\",\"command\":\"just test\",\"exit_code\":0,\"output_snippet\":\"10 passed\",\"timestamp\":\"${ts}\"}]}" \
		> "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json"
}

# ─── a. Nothing recorded → allow, whatever the task is named ─────────────────

@test "no slot, informational task: exits 0 (allow)" {
	run_hook "task-completed-verify.sh" "$TASK_BASIC"
	assert_success
}

@test "no slot, verification-sounding task: exits 0 (allow)" {
	run_hook "task-completed-verify.sh" "$TASK_VERIFY"
	assert_success
}

# ─── b. Slot satisfied by later evidence → allow ─────────────────────────────

@test "slot with evidence logged after it: exits 0 (allow)" {
	_write_slot "$(($(date +%s) - 60))"
	_write_fresh_evidence
	run_hook "task-completed-verify.sh" "$TASK_VERIFY"
	assert_success
}

# ─── c. Verification ran, evidence never followed → block ────────────────────

@test "slot with no evidence at all: exits 2 (block) and names the command" {
	_write_slot
	run_hook "task-completed-verify.sh" "$TASK_BASIC"
	[ "$status" -eq 2 ]
	assert_output --partial "logged no evidence after it"
	assert_output --partial "just test"
}

# ─── d. Evidence predating the verification does not satisfy it ──────────────

@test "evidence older than the slot: exits 2 (block)" {
	_write_fresh_evidence
	touch -d "10 minutes ago" "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json"
	_write_slot
	run_hook "task-completed-verify.sh" "$TASK_VERIFY"
	[ "$status" -eq 2 ]
}

# ─── e. stdin read timeout — warn and allow ──────────────────────────────────

@test "stdin timeout: warns but the state-derived verdict still stands" {
	# The verdict comes from the slot, not the payload, so an unreadable payload
	# costs only the audit line. Allowing here matches drift-guard's posture.
	run env HOOK_INPUT="" HOOK_INPUT_TIMED_OUT=1 \
		CLAUDE_PROJECT_ROOT="${CLAUDE_PROJECT_ROOT}" CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID}" \
		bash "${CLAUDE_PLUGIN_ROOT}/scripts/task-completed-verify.sh"
	assert_success
	assert_output --partial "stdin read timed out"
}

@test "stdin timeout with an unsatisfied slot: still blocks" {
	_write_slot
	run env HOOK_INPUT="" HOOK_INPUT_TIMED_OUT=1 \
		CLAUDE_PROJECT_ROOT="${CLAUDE_PROJECT_ROOT}" CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID}" \
		bash "${CLAUDE_PLUGIN_ROOT}/scripts/task-completed-verify.sh"
	[ "$status" -eq 2 ]
}
