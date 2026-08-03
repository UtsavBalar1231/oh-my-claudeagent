#!/usr/bin/env bats
# Behavioral tests for plan-continuation-guard.sh: Stop hook that nudges the
# agent to keep working when the bound plan still has unchecked numbered
# tasks. Disjoint by construction with final-verification-evidence.sh (that
# gate only fires when the plan is fully checked); both read counts from the
# same count_plan_checkboxes helper.

load '../test_helper'

_write_boulder() {
	local plan_path="$1"
	local session="${2:-${CLAUDE_SESSION_ID}}"
	local bound_at="${3:-$(date +%s)}"
	jq -n --arg plan "${plan_path}" --arg name "test-plan" --arg sid "${session}" --argjson bound_at "${bound_at}" \
		'{"plans":{($name):{"active_plan":$plan,"started_at":"2026-01-01T00:00:00Z","session_ids":[$sid],"agent":"sisyphus"}},"bindings":{($sid):{"plan_name":$name,"bound_at":$bound_at}}}' \
		> "${CLAUDE_PROJECT_ROOT}/.omca/state/boulder.json"
}

_write_unchecked_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# My Plan

- [x] 1. First task
- [ ] 2. Second task not done
EOF
}

_write_complete_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# My Plan

- [x] 1. First task
- [x] 2. Second task
EOF
}

_write_no_boxes_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# Context Document

This is a reference doc with no tasks.
EOF
}

_write_malformed_only_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# My Plan

- [ ] Task without a number
EOF
}

# A Stop block is exit 0 with the decision on stdout.
_assert_blocked() {
	assert_success
	[ "$(jq -r '.decision' <<< "$output")" = "block" ]
	[ -n "$(jq -r '.reason // ""' <<< "$output")" ]
}

_assert_allowed() {
	assert_success
	refute_output --partial '"decision"'
}

_continuation_state() {
	cat "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Core ladder
# ---------------------------------------------------------------------------

@test "plan-continuation-guard: unchecked plan blocks Stop with next-task text" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" '{}'
	_assert_blocked
	echo "$output" | grep -q "Second task not done"
}

@test "plan-continuation-guard: fully-checked plan allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" '{}'
	_assert_allowed
}

@test "plan-continuation-guard: no bound plan allows Stop (exit 0)" {
	run_hook "plan-continuation-guard.sh" '{}'
	_assert_allowed
}

@test "plan-continuation-guard: registered incomplete plan with no binding for this session allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	# Registry has a plan and an unrelated session's binding, but none for
	# this test's CLAUDE_SESSION_ID. Strict resolution must not fall back.
	jq -n --arg plan "${plan_file}" \
		'{"plans":{"other-plan":{"active_plan":$plan,"started_at":"2026-01-01T00:00:00Z","session_ids":["other-session"],"agent":"sisyphus"}},"bindings":{"other-session":{"plan_name":"other-plan","bound_at":1}}}' \
		> "${CLAUDE_PROJECT_ROOT}/.omca/state/boulder.json"

	run_hook "plan-continuation-guard.sh" '{}'
	_assert_allowed
}

@test "plan-continuation-guard: stop_hook_active exits 0 and leaves counters file untouched" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" '{"stop_hook_active":true}'
	_assert_allowed
	[ ! -f "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json" ]
}

@test "plan-continuation-guard: OMCA_DISABLED_HOOKS kill switch exits 0" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	export OMCA_DISABLED_HOOKS="plan-continuation-guard"
	run_hook "plan-continuation-guard.sh" '{}'
	_assert_allowed
	unset OMCA_DISABLED_HOOKS
}

# ---------------------------------------------------------------------------
# Cooldown / hard cap / stagnation
# ---------------------------------------------------------------------------

@test "plan-continuation-guard: cooldown suppresses a second rapid invocation (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" '{}'
	_assert_blocked

	run_hook "plan-continuation-guard.sh" '{}'
	_assert_allowed
}

@test "plan-continuation-guard: stagnation escape frees the 4th identical-count invocation" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	for _ in 1 2 3; do
		# Force last_block_at into the past between calls so cooldown never
		# masks the stagnation logic under test.
		if [[ -f "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json" ]]; then
			jq '.last_block_at = 0' "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json" \
				> "${BATS_TEST_TMPDIR}/pc.json" && mv "${BATS_TEST_TMPDIR}/pc.json" "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json"
		fi
		run_hook "plan-continuation-guard.sh" '{}'
		_assert_blocked
	done

	jq '.last_block_at = 0' "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json" \
		> "${BATS_TEST_TMPDIR}/pc.json" && mv "${BATS_TEST_TMPDIR}/pc.json" "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json"
	run_hook "plan-continuation-guard.sh" '{}'
	_assert_allowed
	[ "$(jq -r '.stagnated' "${CLAUDE_PROJECT_ROOT}/.omca/state/plan-continuation.json")" = "true" ]
}

# ---------------------------------------------------------------------------
# User-pause rail
# ---------------------------------------------------------------------------

@test "plan-continuation-guard: user-pause intent in the transcript allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	# The pause rail has no payload field to read, so it tails the transcript
	# JSONL: `.type` and `.message.role` both carry the speaker's role.
	local transcript="${BATS_TEST_TMPDIR}/transcript.jsonl"
	cat > "${transcript}" <<'EOF'
{"type":"user","message":{"role":"user","content":"start on task 2"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working on it."}]}}
{"type":"user","message":{"role":"user","content":"lets pause here for now"}}
EOF
	local payload
	payload=$(jq -n --arg tp "${transcript}" '{"hook_event_name":"Stop","stop_hook_active":false,"transcript_path":$tp}')

	run_hook "plan-continuation-guard.sh" "${payload}"
	_assert_allowed
}

@test "plan-continuation-guard: same transcript without a pause phrase still blocks" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local transcript="${BATS_TEST_TMPDIR}/transcript.jsonl"
	cat > "${transcript}" <<'EOF'
{"type":"user","message":{"role":"user","content":"start on task 2"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working on it."}]}}
{"type":"user","message":{"role":"user","content":"keep going"}}
EOF
	local payload
	payload=$(jq -n --arg tp "${transcript}" '{"hook_event_name":"Stop","stop_hook_active":false,"transcript_path":$tp}')

	run_hook "plan-continuation-guard.sh" "${payload}"
	_assert_blocked
}

# ---------------------------------------------------------------------------
# Needs-user-input rail: the BLOCKING QUESTIONS marker OR an AskUserQuestion
# call recorded in the current turn's transcript. Neither one present blocks.
# ---------------------------------------------------------------------------

# Shape confirmed against a live transcript: the call lands as an assistant
# record whose content array holds {"type":"tool_use","name":"AskUserQuestion"}.
_write_ask_user_question_transcript() {
	local transcript="$1"
	cat > "${transcript}" <<'EOF'
{"type":"user","message":{"role":"user","content":"work through the plan"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Task 2 forks two ways."}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"AskUserQuestion","input":{}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"recursive descent"}]}}
EOF
}

@test "plan-continuation-guard: an AskUserQuestion call in this turn allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local transcript="${BATS_TEST_TMPDIR}/transcript.jsonl"
	_write_ask_user_question_transcript "${transcript}"

	run_hook "plan-continuation-guard.sh" \
		"$(jq -n --arg tp "${transcript}" '{"transcript_path":$tp,"last_assistant_message":"Task 2 forks two ways."}')"
	_assert_allowed
	assert_output '{}'
}

# The escape is turn-scoped: a real human prompt after the call bounds the scan,
# so an answered question cannot keep freeing every later Stop.
@test "plan-continuation-guard: an AskUserQuestion call before a later user prompt still blocks" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local transcript="${BATS_TEST_TMPDIR}/transcript.jsonl"
	_write_ask_user_question_transcript "${transcript}"
	echo '{"type":"user","message":{"role":"user","content":"go with recursive descent"}}' >> "${transcript}"
	echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Understood."}]}}' >> "${transcript}"

	run_hook "plan-continuation-guard.sh" \
		"$(jq -n --arg tp "${transcript}" '{"transcript_path":$tp,"last_assistant_message":"Understood."}')"
	_assert_blocked
}

@test "plan-continuation-guard: no marker and no AskUserQuestion call blocks" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local transcript="${BATS_TEST_TMPDIR}/transcript.jsonl"
	cat > "${transcript}" <<'EOF'
{"type":"user","message":{"role":"user","content":"work through the plan"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"file body"}]}}
EOF

	run_hook "plan-continuation-guard.sh" \
		"$(jq -n --arg tp "${transcript}" '{"transcript_path":$tp,"last_assistant_message":"Read the file, moving on."}')"
	_assert_blocked
}

# A main-session turn that asks in prose without the marker and without the tool
# call has produced no signal the guard can trust, so it blocks.
@test "plan-continuation-guard: a prose question with no marker and no tool call blocks" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local transcript="${BATS_TEST_TMPDIR}/transcript.jsonl"
	cat > "${transcript}" <<'EOF'
{"type":"user","message":{"role":"user","content":"work through the plan"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Which parser should task 2 use, recursive descent or generated?"}]}}
EOF

	run_hook "plan-continuation-guard.sh" \
		"$(jq -n --arg tp "${transcript}" '{"transcript_path":$tp,"last_assistant_message":"Which parser should task 2 use, recursive descent or generated?"}')"
	_assert_blocked
}

@test "plan-continuation-guard: a declared BLOCKING QUESTIONS block allows Stop (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local msg
	msg=$'Task 2 needs a decision.\n\n## BLOCKING QUESTIONS\n\nQ1. Which parser?\nA) recursive descent\nB) generated\nRecommended: A'
	run_hook "plan-continuation-guard.sh" "$(jq -n --arg m "${msg}" '{"last_assistant_message":$m}')"
	_assert_allowed
	assert_output '{}'
}

@test "plan-continuation-guard: a trailing question mark is not an escape and still blocks" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "plan-continuation-guard.sh" '{"last_assistant_message":"Should I refactor the parser first?"}'
	_assert_blocked
}

# ---------------------------------------------------------------------------
# Corrupt registry
# ---------------------------------------------------------------------------

@test "plan-continuation-guard: unparseable boulder.json blocks instead of reading as no plan" {
	printf 'NOT JSON {' > "${CLAUDE_PROJECT_ROOT}/.omca/state/boulder.json"

	run_hook "plan-continuation-guard.sh" '{}'
	_assert_blocked
	echo "$output" | grep -q "not valid JSON"
}

@test "plan-continuation-guard: a failed counter write still blocks" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"
	chmod a-w "${CLAUDE_PROJECT_ROOT}/.omca/state"

	run_hook "plan-continuation-guard.sh" '{}'
	chmod u+w "${CLAUDE_PROJECT_ROOT}/.omca/state"
	_assert_blocked
}

# ---------------------------------------------------------------------------
# Disjointness matrix: at most one of the three Stop gates blocks per state
# ---------------------------------------------------------------------------

# Each gate signals a block with stdout JSON, so read the decision, not the status.
_blocked() {
	local script="$1"
	local payload="$2"
	local out
	out=$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/${script}" <<< "${payload}" 2>/dev/null)
	if [ "$(jq -r '.decision // ""' <<< "${out}")" = "block" ]; then
		echo 1
	else
		echo 0
	fi
}

@test "disjointness matrix: unchecked plan state" {
	local plan_file="${BATS_TEST_TMPDIR}/unchecked-plan.md"
	_write_unchecked_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local s1 s2 s3
	s1=$(_blocked "plan-continuation-guard.sh" '{}')
	s2=$(_blocked "final-verification-evidence.sh" '{}')
	s3=$(_blocked "drift-guard.sh" '{}')

	[ "$((s1 + s2 + s3))" -le 1 ]
	[ "$s1" -eq 1 ]
}

@test "disjointness matrix: fully-checked plan state" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local s1 s2 s3
	s1=$(_blocked "plan-continuation-guard.sh" '{}')
	s2=$(_blocked "final-verification-evidence.sh" '{}')
	s3=$(_blocked "drift-guard.sh" '{}')

	[ "$((s1 + s2 + s3))" -le 1 ]
	[ "$s2" -eq 1 ]
}

@test "disjointness matrix: no-checkboxes plan state" {
	local plan_file="${BATS_TEST_TMPDIR}/no-boxes-plan.md"
	_write_no_boxes_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local s1 s2 s3
	s1=$(_blocked "plan-continuation-guard.sh" '{}')
	s2=$(_blocked "final-verification-evidence.sh" '{}')
	s3=$(_blocked "drift-guard.sh" '{}')

	[ "$((s1 + s2 + s3))" -le 1 ]
	[ "$s1" -eq 0 ]
	[ "$s2" -eq 0 ]
}

@test "disjointness matrix: malformed-only (unnumbered) checkbox plan state" {
	local plan_file="${BATS_TEST_TMPDIR}/malformed-plan.md"
	_write_malformed_only_plan "${plan_file}"
	_write_boulder "${plan_file}"

	local s1 s2 s3
	s1=$(_blocked "plan-continuation-guard.sh" '{}')
	s2=$(_blocked "final-verification-evidence.sh" '{}')
	s3=$(_blocked "drift-guard.sh" '{}')

	[ "$((s1 + s2 + s3))" -le 1 ]
	[ "$s1" -eq 0 ]
	[ "$s2" -eq 0 ]
}
