#!/usr/bin/env bats
# Behavioral tests for pre-compact.sh (PreCompact hook).
# The hook writes a compaction context file and exits 0 — no blocking logic.

load '../test_helper'

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ─── a. no active plan — permit and write context ────────────────────────────

@test "pre-compact exits 0 when no active plan in boulder" {
	# Boulder absent entirely
	export CLAUDE_SESSION_ID="bats-test-session"
	run_hook "pre-compact.sh" '{"session_id":"bats-test-session","hook_event_name":"PreCompact","trigger":"auto"}'
	assert_success
	[[ "${output}" != *'"decision":"block"'* ]]
}

# ─── b. notepad summaries written to context file ────────────────────────────

@test "pre-compact writes notepad summary lines to compaction-context.md" {
	local notes_dir="${CLAUDE_PROJECT_ROOT}/.omca/state/notepads/my-plan"
	mkdir -p "${notes_dir}"
	printf 'line1\nline2\n' > "${notes_dir}/learnings.md"

	export CLAUDE_SESSION_ID="bats-test-session"
	run_hook "pre-compact.sh" '{"session_id":"bats-test-session","hook_event_name":"PreCompact","trigger":"auto"}'
	assert_success

	local ctx="${CLAUDE_PROJECT_ROOT}/.omca/state/compaction-context.md"
	assert [ -f "${ctx}" ]
	grep -q "my-plan" "${ctx}"
	grep -q "learnings" "${ctx}"
}

# ─── c. latest evidence entry written to context file ────────────────────────

@test "pre-compact writes latest evidence entry to compaction-context.md" {
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/evidence"
	printf '%s' "{\"entries\":[{\"type\":\"test\",\"command\":\"just test\",\"exit_code\":0,\"output_snippet\":\"5 passed\",\"timestamp\":\"${TS}\"}]}" \
		> "${CLAUDE_PROJECT_ROOT}/.omca/evidence/verification-evidence.json"

	export CLAUDE_SESSION_ID="bats-test-session"
	run_hook "pre-compact.sh" '{"session_id":"bats-test-session","hook_event_name":"PreCompact","trigger":"auto"}'
	assert_success

	local ctx="${CLAUDE_PROJECT_ROOT}/.omca/state/compaction-context.md"
	assert [ -f "${ctx}" ]
	grep -q "type=test" "${ctx}"
}
