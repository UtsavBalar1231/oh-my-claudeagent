#!/usr/bin/env bats
# Behavioral tests for final-verification-evidence.sh — F1-F4 evidence gate on Stop.

load '../test_helper'

PLAN_SHA="deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
NOW=$(date +%s)

# Write a synthetic boulder.json pointing to a plan file
_write_boulder() {
	local plan_path="$1"
	write_state "boulder.json" "{\"active_plan\":\"${plan_path}\",\"status\":\"active\"}"
}

# Write a plan file with all checkboxes complete
_write_complete_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# My Plan

## TODOs

- [x] 1. First task
- [x] 2. Second task
- [x] 3. Third task
EOF
}

# Write a plan file with one incomplete checkbox
_write_incomplete_plan() {
	local plan_path="$1"
	cat > "${plan_path}" <<'EOF'
# My Plan

## TODOs

- [x] 1. First task
- [ ] 2. Second task not done
EOF
}

# Write a verification-evidence.json with specified F-types (all matching same SHA)
_write_evidence_with_ftypes() {
	local -a ftypes=("$@")
	local entries="[]"
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	for ftype in "${ftypes[@]}"; do
		entries=$(echo "${entries}" | jq \
			--arg t "${ftype}" \
			--arg ts "${ts}" \
			--arg sha "${PLAN_SHA}" \
			'. + [{"type":$t,"command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts}]')
	done
	write_state "verification-evidence.json" "{\"entries\":${entries}}"
}

# Write a pending-final-verify.json marker
# Usage: _write_marker <plan_path> [marked_at] [session_id] [plan_sha256]
_write_marker() {
	local plan_path="$1"
	local marked_at="${2:-${NOW}}"
	local session_id="${3:-bats-test-session}"
	local plan_sha="${4:-${PLAN_SHA}}"
	write_state "pending-final-verify.json" \
		"{\"plan_path\":\"${plan_path}\",\"plan_sha256\":\"${plan_sha}\",\"marked_at\":${marked_at},\"session_id\":\"${session_id}\"}"
}

# ---------------------------------------------------------------------------
# (a) No active boulder AND no pending-final-verify marker → exit 0
# ---------------------------------------------------------------------------

@test "final-verification-evidence: no active plan and no marker allows Stop (exit 0)" {
	# State dir is empty — no boulder.json, no marker, no evidence
	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (b) Active plan with incomplete checkboxes → exit 0 (not our concern)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: incomplete checkboxes pass through (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/incomplete-plan.md"
	_write_incomplete_plan "${plan_file}"
	_write_boulder "${plan_file}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (c) All checkboxes [x], all 4 F-types present with matching plan SHA → exit 0
# ---------------------------------------------------------------------------

@test "final-verification-evidence: all checkboxes done and all 4 F-types present (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	_write_evidence_with_ftypes \
		"final_verification_f1" \
		"final_verification_f2" \
		"final_verification_f3" \
		"final_verification_f4"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (d) All checkboxes [x], F3 missing → exit 2, stderr names missing F-types
# ---------------------------------------------------------------------------

@test "final-verification-evidence: missing F3 blocks Stop (exit 2) and names it" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	_write_marker "${plan_file}"
	_write_evidence_with_ftypes \
		"final_verification_f1" \
		"final_verification_f2" \
		"final_verification_f4"

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "final_verification_f3"
}

# ---------------------------------------------------------------------------
# (e) stop_hook_active=true → exit 0 (recursion guard)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: stop_hook_active guard exits 0" {
	local plan_file="${BATS_TEST_TMPDIR}/complete-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# No evidence written — would normally block, but guard fires first

	run_hook "final-verification-evidence.sh" '{"stop_hook_active":true}'
	assert_success
}

# ---------------------------------------------------------------------------
# (f) No active boulder but fresh pending-final-verify marker + F-types missing → exit 2
# ---------------------------------------------------------------------------

@test "final-verification-evidence: marker present without evidence blocks Stop (exit 2)" {
	local plan_file="${BATS_TEST_TMPDIR}/marker-plan.md"
	_write_complete_plan "${plan_file}"
	# No boulder.json — simulates /stop-continuation clearing it
	_write_marker "${plan_file}"
	# No evidence written

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# (g) All 4 F-types present but plan_sha256 mismatch across entries → exit 2
# ---------------------------------------------------------------------------

@test "final-verification-evidence: SHA mismatch across F-type entries blocks Stop (exit 2)" {
	local plan_file="${BATS_TEST_TMPDIR}/sha-mismatch-plan.md"
	_write_complete_plan "${plan_file}"
	local real_sha
	real_sha=$(sha256sum "${plan_file}" | awk '{print $1}')
	_write_boulder "${plan_file}"
	_write_marker "${plan_file}"

	# F1/F2/F4 match real_sha; F3 uses a different SHA — cross-check must detect mismatch
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local entries
	entries=$(jq -n --arg ts "${ts}" --arg sha "${real_sha}" '[
		{"type":"final_verification_f1","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
		{"type":"final_verification_f2","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
		{"type":"final_verification_f3","command":"oracle: APPROVE","exit_code":0,"output_snippet":"plan_sha256:cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe verdict:APPROVE","timestamp":$ts},
		{"type":"final_verification_f4","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts}
	]')
	write_state "verification-evidence.json" "{\"entries\":${entries}}"

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "final_verification_f3"
}

# ---------------------------------------------------------------------------
# (h) Background-subagent guard: active running agent → skip F1-F4, return {}
# ---------------------------------------------------------------------------

@test "final-verification: background-subagent guard skips F1-F4 enforcement" {
	local plan_file="${BATS_TEST_TMPDIR}/bg-agent-plan.md"
	_write_complete_plan "${plan_file}"
	_write_boulder "${plan_file}"
	# No evidence written — would normally block with exit 2 once all tasks done

	# Write subagents.json with one running agent (started_epoch within last 900s)
	local now
	now=$(date +%s)
	write_state "subagents.json" \
		"{\"active\":[{\"status\":\"running\",\"started_epoch\":${now},\"name\":\"fake-agent\"}]}"

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 0 ]
	[ "$output" = "{}" ]
}

# ---------------------------------------------------------------------------
# (i) Sidecar write (.omca/notes/<basename>-completion.md) does not affect
#     plan SHA or F1-F4 hook enforcement — hook must still exit 0 with '{}'
# ---------------------------------------------------------------------------

@test "final-verification: sidecar write does not affect plan SHA or hook enforcement" {
	# Plan file with all numbered tasks checked off, no ### Final Checklist section
	local plan_file="${BATS_TEST_TMPDIR}/sidecar-test-plan.md"
	cat > "${plan_file}" <<'EOF'
# Sidecar Test Plan

## TODOs

- [x] 1. First task
- [x] 2. Second task
- [x] 3. Third task
- [x] 4. Fourth task
EOF

	# Compute plan SHA BEFORE writing any sidecar — this is what the hook will compute
	local plan_sha
	plan_sha=$(sha256sum "${plan_file}" | awk '{print $1}')

	_write_boulder "${plan_file}"

	# Write all 4 F-type evidence entries with matching plan SHA in output_snippet
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local entries
	entries=$(jq -n \
		--arg ts "${ts}" \
		--arg sha "${plan_sha}" \
		'[
			{"type":"final_verification_f1","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f2","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f3","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f4","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts}
		]')
	write_state "verification-evidence.json" "{\"entries\":${entries}}"

	# Write optional pending-final-verify marker (exercises Task 4c auto-clear path)
	write_state "pending-final-verify.json" \
		"{\"plan_path\":\"${plan_file}\",\"plan_sha256\":\"${plan_sha}\",\"marked_at\":${NOW},\"session_id\":\"bats-test-session\"}"

	# Write sidecar AFTER evidence entries — at .omca/notes/<basename>-completion.md
	# This file is intentionally OUTSIDE the plan file; its presence must NOT alter the plan SHA
	local plan_basename
	plan_basename=$(basename "${plan_file}" .md)
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/notes"
	cat > "${CLAUDE_PROJECT_ROOT}/.omca/notes/${plan_basename}-completion.md" <<EOF
---
plan: ${plan_file}
plan_sha256: ${plan_sha}
completed_at: ${ts}
---

Sidecar completion note written after evidence entries.
EOF

	# Run the hook — sidecar must not affect plan SHA; hook must exit 0 with '{}'
	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 0 ]
	[ "$output" = "{}" ]

	# Auto-clear: pending-final-verify.json should have been removed by the hook
	[ ! -f "${CLAUDE_PROJECT_ROOT}/.omca/state/pending-final-verify.json" ]
}

# ---------------------------------------------------------------------------
# (j) Short-circuit #1: session-ID mismatch clears stale marker (exit 0)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: session-ID mismatch clears stale marker (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/sc1-plan.md"
	_write_complete_plan "${plan_file}"
	# Marker written under a different session than the current one
	_write_marker "${plan_file}" "${NOW}" "old-session"
	# No evidence — would block if marker were not cleared by session-ID mismatch

	export CLAUDE_SESSION_ID="new-session"
	run_hook "final-verification-evidence.sh" '{}'
	assert_success
	[ ! -f "${CLAUDE_PROJECT_ROOT}/.omca/state/pending-final-verify.json" ]
}

# ---------------------------------------------------------------------------
# (k) Short-circuit #2: sidecar SHA match clears stale marker (exit 0)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: sidecar SHA match clears stale marker (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/sc2-plan.md"
	_write_complete_plan "${plan_file}"

	# Compute the real SHA of the plan file (what the hook will compute)
	local plan_sha
	plan_sha=$(sha256sum "${plan_file}" | awk '{print $1}')

	# Marker uses the same session_id as the env var (so SC#1 does NOT fire)
	_write_marker "${plan_file}" "${NOW}" "bats-test-session" "${plan_sha}"
	# No F1-F4 evidence — would block if sidecar short-circuit did not fire

	# Write sidecar with matching SHA at the path compute_sidecar_path would resolve
	local plan_basename
	plan_basename=$(basename "${plan_file}" .md)
	mkdir -p "${CLAUDE_PROJECT_ROOT}/.omca/notes"
	cat > "${CLAUDE_PROJECT_ROOT}/.omca/notes/${plan_basename}-completion.md" <<EOF
---
plan: ${plan_file}
plan_sha256: ${plan_sha}
completed_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
---

Sidecar written to confirm plan closure.
EOF

	# CLAUDE_SESSION_ID already exported as "bats-test-session" by setup()
	run_hook "final-verification-evidence.sh" '{}'
	assert_success
	[ ! -f "${CLAUDE_PROJECT_ROOT}/.omca/state/pending-final-verify.json" ]
}

# ---------------------------------------------------------------------------
# (l) Short-circuit #3: zero [x] progress clears stale marker (exit 0)
# ---------------------------------------------------------------------------

@test "final-verification-evidence: zero [x] progress clears stale marker (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/sc3-plan.md"
	# Plan has only unchecked boxes — never started
	cat > "${plan_file}" <<'EOF'
# Stale Plan

## TODOs

- [ ] 1. First task not started
- [ ] 2. Second task not started
EOF

	_write_marker "${plan_file}" "${NOW}" "bats-test-session"
	# No evidence — would block if marker were not cleared by zero-[x] short-circuit

	# CLAUDE_SESSION_ID already exported as "bats-test-session" by setup()
	run_hook "final-verification-evidence.sh" '{}'
	assert_success
	[ ! -f "${CLAUDE_PROJECT_ROOT}/.omca/state/pending-final-verify.json" ]
}

# ---------------------------------------------------------------------------
# (m) Incident replay — orphan marker + current plan evidence under different SHA
# ---------------------------------------------------------------------------

@test "final-verification-evidence: incident replay — orphan marker + current plan evidence (exit 0)" {
	# plan_A: orphan from a previous session — complete plan with SHA_A
	local plan_a="${BATS_TEST_TMPDIR}/plan-a.md"
	_write_complete_plan "${plan_a}"
	local sha_a
	sha_a=$(sha256sum "${plan_a}" | awk '{print $1}')

	# plan_B: current active plan — complete plan with SHA_B (different file → different SHA)
	local plan_b="${BATS_TEST_TMPDIR}/plan-b.md"
	cat > "${plan_b}" <<'EOF'
# Current Plan

## TODOs

- [x] 1. Alpha task
- [x] 2. Beta task
- [x] 3. Gamma task
- [x] 4. Delta task
EOF
	local sha_b
	sha_b=$(sha256sum "${plan_b}" | awk '{print $1}')

	# Orphan marker for plan_A under an old session
	_write_marker "${plan_a}" "${NOW}" "11h-ago-session" "${sha_a}"

	# Active boulder points to plan_B
	_write_boulder "${plan_b}"

	# F1-F4 evidence scoped to SHA_B (the current plan)
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local entries
	entries=$(jq -n \
		--arg ts "${ts}" \
		--arg sha "${sha_b}" \
		'[
			{"type":"final_verification_f1","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f2","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f3","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f4","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts}
		]')
	write_state "verification-evidence.json" "{\"entries\":${entries}}"

	# Snapshot boulder and evidence contents before hook run
	local boulder_before evidence_before
	boulder_before=$(read_state "boulder.json")
	evidence_before=$(read_state "verification-evidence.json")

	export CLAUDE_SESSION_ID="current-session"
	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 0 ]
	[ "$output" = "{}" ]

	# Orphan marker must be gone (cleared by session-ID mismatch short-circuit)
	[ ! -f "${CLAUDE_PROJECT_ROOT}/.omca/state/pending-final-verify.json" ]

	# boulder.json and verification-evidence.json must be unchanged
	[ "$(read_state "boulder.json")" = "${boulder_before}" ]
	[ "$(read_state "verification-evidence.json")" = "${evidence_before}" ]
}

# ---------------------------------------------------------------------------
# (n) Regression guard: same-session marker + missing evidence still blocks
# ---------------------------------------------------------------------------

@test "final-verification-evidence: same-session marker + missing evidence still blocks (regression)" {
	local plan_file="${BATS_TEST_TMPDIR}/regression-plan.md"
	_write_complete_plan "${plan_file}"

	local plan_sha
	plan_sha=$(sha256sum "${plan_file}" | awk '{print $1}')

	# Marker under the SAME session_id as CLAUDE_SESSION_ID — no session-ID mismatch
	_write_marker "${plan_file}" "${NOW}" "session-X" "${plan_sha}"
	# No sidecar — SC#2 must not fire
	# No F1-F4 evidence — must still block

	export CLAUDE_SESSION_ID="session-X"
	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "F1-F4 evidence missing"

	# Marker must still be present (not erroneously cleared)
	[ -f "${CLAUDE_PROJECT_ROOT}/.omca/state/pending-final-verify.json" ]
}
