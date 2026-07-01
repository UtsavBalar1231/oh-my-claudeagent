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

# ─── d. real remaining-task lines, tasks before decisions, tail markers ──────

@test "pre-compact inlines real remaining tasks and decisions, tasks before decisions, with tail markers" {
	local plan="${CLAUDE_PROJECT_ROOT}/bound-plan.md"
	{
		echo "# Plan"
		for i in $(seq 1 15); do echo "- [ ] ${i}. Task number ${i} description"; done
	} > "${plan}"

	cat > "${CLAUDE_PROJECT_ROOT}/.omca/state/boulder.json" <<EOF
{"plans": {"bound-plan": {"active_plan": "${plan}", "started_at": "${TS}", "session_ids": ["bats-test-session"], "agent": "sisyphus"}}, "bindings": {"bats-test-session": {"plan_name": "bound-plan", "bound_at": "${TS}"}}}
EOF

	local notes_dir="${CLAUDE_PROJECT_ROOT}/.omca/state/notepads/bound-plan"
	mkdir -p "${notes_dir}"
	for i in $(seq 1 7); do
		printf '\n## 2026-01-0%dT00:00:00Z\n\nDecision number %d content here.\n' "${i}" "${i}" >> "${notes_dir}/decisions.md"
	done

	export CLAUDE_SESSION_ID="bats-test-session"
	run_hook "pre-compact.sh" '{"session_id":"bats-test-session","hook_event_name":"PreCompact","trigger":"manual"}'
	assert_success

	local ctx="${CLAUDE_PROJECT_ROOT}/.omca/state/compaction-context.md"
	assert [ -f "${ctx}" ]

	# Real task lines (not a "check boulder.json" pointer), capped at 10, tail marker present.
	grep -q -- "- \[ \] 1\. Task number 1 description" "${ctx}"
	grep -q -- "- \[ \] 10\. Task number 10 description" "${ctx}"
	! grep -q -- "- \[ \] 11\. Task number 11 description" "${ctx}"
	grep -q -- "…5 more (see boulder.json / notepad)" "${ctx}"

	# Real decision content (most-recent 5 of 7), tail marker present.
	grep -q "Decision number 3 content here." "${ctx}"
	grep -q "Decision number 7 content here." "${ctx}"
	! grep -q "Decision number 2 content here." "${ctx}"
	grep -q -- "…2 more (see boulder.json / notepad)" "${ctx}"

	# Tasks section must precede decisions section.
	local tasks_line decisions_line
	tasks_line=$(grep -n "^## Remaining tasks" "${ctx}" | cut -d: -f1)
	decisions_line=$(grep -n "^## Decisions" "${ctx}" | cut -d: -f1)
	[[ "${tasks_line}" -lt "${decisions_line}" ]]
}

# ─── e. no bound plan — degrades to pointer behavior ─────────────────────────

@test "pre-compact degrades to pointer text when no plan is bound to this session" {
	export CLAUDE_SESSION_ID="unbound-session"
	run_hook "pre-compact.sh" '{"session_id":"unbound-session","hook_event_name":"PreCompact","trigger":"manual"}'
	assert_success

	local ctx="${CLAUDE_PROJECT_ROOT}/.omca/state/compaction-context.md"
	assert [ -f "${ctx}" ]
	grep -q "Check boulder.json for active plan and remaining tasks." "${ctx}"
	grep -q "No decisions recorded yet." "${ctx}"
}
