#!/usr/bin/env bats
load '../test_helper'

TASK_BASIC='{"task_description":"status report only"}'
TASK_VERIFY='{"task_description":"all tests pass — implement and verify the build"}'

# Helper: write a valid verification-evidence.json into the state dir
_write_fresh_evidence() {
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	write_state "verification-evidence.json" \
		"{\"entries\":[{\"type\":\"test\",\"command\":\"just test\",\"exit_code\":0,\"output_snippet\":\"10 passed\",\"timestamp\":\"${ts}\"}]}"
}

# ─── a. No evidence, no edits → allow ────────────────────────────────────────

@test "no evidence file, no edits log, informational task: exits 0 (allow)" {
	run_hook "task-completed-verify.sh" "$TASK_BASIC"
	assert_success
}

# ─── b. Evidence exists and is fresh → allow ─────────────────────────────────

@test "valid fresh evidence, verification task: exits 0 (allow)" {
	_write_fresh_evidence
	run_hook "task-completed-verify.sh" "$TASK_VERIFY"
	assert_success
}

# ─── c. Evidence missing, task claims verification → allow (no edits) ────────
# Script logic: block only when RECENT_EDITS=true AND NEEDS_EVIDENCE=true and no evidence.
# With no edits log, even a verification-sounding task is allowed (informational fallback).

@test "no evidence, no edits log, verification task: exits 0 (informational fallback)" {
	run_hook "task-completed-verify.sh" "$TASK_VERIFY"
	assert_success
}

# ─── d. Recent edits + no evidence + verification task → block ────────────────

@test "recent edits log, no evidence, verification task: exits 2 (block)" {
	# Create a fresh edits.jsonl so RECENT_EDITS=true
	printf '{"event":"edit","file":"foo.sh"}\n' > "$CLAUDE_PROJECT_ROOT/.omca/logs/edits.jsonl"
	run_hook "task-completed-verify.sh" "$TASK_VERIFY"
	# exit 2 means blocked — bats 'run' captures exit code in $status
	[ "$status" -eq 2 ]
}

# ─── e. Evidence stale (>5 min) + recent edits → block ───────────────────────

@test "stale evidence (>5 min) with recent edits: exits 2 (block)" {
	_write_fresh_evidence
	# Back-date evidence by 10 minutes so RECENT_EVIDENCE becomes false
	touch -d "10 minutes ago" "$CLAUDE_PROJECT_ROOT/.omca/state/verification-evidence.json"
	# Fresh edits log so RECENT_EDITS=true
	printf '{"event":"edit","file":"bar.sh"}\n' > "$CLAUDE_PROJECT_ROOT/.omca/logs/edits.jsonl"
	run_hook "task-completed-verify.sh" "$TASK_VERIFY"
	[ "$status" -eq 2 ]
}
