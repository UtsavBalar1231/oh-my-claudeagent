#!/usr/bin/env bats
load '../test_helper'

# ─── Regex boundary tests (H-7 part 1) ──────────────────────────────────────
#
# The NEEDS_EVIDENCE regex requires word boundaries (^|[^[:alnum:]]) so that
# partial-word matches like "verification", "implementation", "verifying" do
# not trigger a false-positive evidence demand.

# Helper: write a valid verification-evidence.json into the state dir
_write_fresh_evidence() {
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	write_state "verification-evidence.json" \
		"{\"entries\":[{\"type\":\"test\",\"command\":\"just test\",\"exit_code\":0,\"output_snippet\":\"10 passed\",\"timestamp\":\"${ts}\"}]}"
}

# ─── Negative fixtures — must NOT trigger evidence demand ────────────────────

@test "regex negative: 'documenting verification' exits 0 (no demand)" {
	run_hook "task-completed-verify.sh" '{"task_description":"documenting verification steps"}'
	assert_success
}

@test "regex negative: 'implementation plan' exits 0 (no demand)" {
	run_hook "task-completed-verify.sh" '{"task_description":"write the implementation plan"}'
	assert_success
}

@test "regex negative: 'verifying that' exits 0 (no demand)" {
	run_hook "task-completed-verify.sh" '{"task_description":"verifying that the docs are current"}'
	assert_success
}

@test "regex negative: 'built the feature' exits 0 (no demand)" {
	run_hook "task-completed-verify.sh" '{"task_description":"built the feature description"}'
	assert_success
}

# ─── Positive fixtures — must trigger evidence demand when evidence missing ──

@test "regex positive: 'fix the bug' with no evidence exits 2 (demand)" {
	run_hook "task-completed-verify.sh" '{"task_description":"fix the bug in parser"}'
	[ "$status" -eq 2 ]
}

@test "regex positive: 'verify the build' with no evidence exits 2 (demand)" {
	run_hook "task-completed-verify.sh" '{"task_description":"verify the build passes"}'
	[ "$status" -eq 2 ]
}

@test "regex positive: 'deploy to staging' with no evidence exits 2 (demand)" {
	run_hook "task-completed-verify.sh" '{"task_description":"deploy to staging environment"}'
	[ "$status" -eq 2 ]
}

@test "regex positive: 'run test' with no evidence exits 2 (demand)" {
	run_hook "task-completed-verify.sh" '{"task_description":"run test for the new module"}'
	[ "$status" -eq 2 ]
}

@test "regex positive: 'fix the bug' with fresh evidence exits 0 (allow)" {
	_write_fresh_evidence
	run_hook "task-completed-verify.sh" '{"task_description":"fix the bug in parser"}'
	assert_success
}

# ─── Stat fail-closed tests (H-7 part 2) ─────────────────────────────────────
#
# When stat cannot determine mtime (unreadable file, unknown format), the hook
# must fail closed — RECENT_EVIDENCE stays false — so evidence is demanded for
# verification tasks rather than silently passing.

@test "stat fail-closed: corrupt evidence file + verification task exits 2 (demand)" {
	# Write a corrupt (non-JSON, stat-readable) evidence file; mtime parsing
	# succeeds but the content will fail schema validation — the important path
	# here is that RECENT_EVIDENCE is set from the mtime, not defaulted to true.
	# To exercise the fail-closed stat path we make the file unreadable so that
	# stat -c and stat -f both fail → EVIDENCE_MTIME="" → not ^[0-9]+$.
	write_state "verification-evidence.json" "not-json"
	chmod 000 "$CLAUDE_PROJECT_ROOT/.omca/state/verification-evidence.json"
	run_hook "task-completed-verify.sh" '{"task_description":"fix the regression"}'
	# Restore perms so teardown can clean up
	chmod 644 "$CLAUDE_PROJECT_ROOT/.omca/state/verification-evidence.json" 2>/dev/null || true
	[ "$status" -eq 2 ]
}

@test "stat fail-closed: no evidence file + informational task exits 0 (allow)" {
	# Informational task never sets NEEDS_EVIDENCE — even with fail-closed stat
	# (no evidence file present), exit 0 because demand is never triggered.
	run_hook "task-completed-verify.sh" '{"task_description":"update the documentation"}'
	assert_success
}
