#!/usr/bin/env bats
# Integration test for final-verification-evidence.sh F1-F4 enforcement chain.
# Exercises parser + decision logic against the documented verification-evidence.json schema.
# Does NOT test the live MCP evidence_log tool path — that's covered by servers/tests/test_evidence.py.

load '../test_helper'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_write_integration_plan() {
	local plan_path="$1"
	# Use printf to write a plan with 2 completed checkboxes
	printf '%s\n' \
		'# Integration Test Plan' \
		'' \
		'## Tasks' \
		'' \
		'- [x] 1. First integration task' \
		'- [x] 2. Second integration task' \
		> "${plan_path}"
}

_compute_sha256() {
	local plan_path="$1"
	sha256sum "${plan_path}" | awk '{print $1}'
}

_write_boulder_for() {
	local plan_path="$1"
	write_state "boulder.json" \
		"{\"active_plan\":\"${plan_path}\",\"status\":\"active\"}"
}

_write_all_ftypes() {
	local sha="$1"
	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local entries
	entries=$(jq -n \
		--arg ts "${ts}" \
		--arg sha "${sha}" \
		'[
			{"type":"final_verification_f1","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f2","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f3","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts},
			{"type":"final_verification_f4","command":"oracle: APPROVE","exit_code":0,"output_snippet":("plan_sha256:" + $sha + " verdict:APPROVE"),"timestamp":$ts}
		]')
	write_state "verification-evidence.json" "{\"entries\":${entries}}"
}

_remove_ftype() {
	local ftype="$1"
	local evidence_file="${CLAUDE_PROJECT_ROOT}/.omca/state/verification-evidence.json"
	local tmp
	tmp=$(mktemp)
	jq --arg t "${ftype}" '.entries |= map(select(.type != $t))' \
		"${evidence_file}" > "${tmp}"
	mv "${tmp}" "${evidence_file}"
}

# ---------------------------------------------------------------------------
# (a) Happy path: synthetic plan + all 4 F-types with matching SHA → exit 0
# ---------------------------------------------------------------------------

@test "integration: all 4 F-types present with real plan SHA → exit 0" {
	local plan_file="${BATS_TEST_TMPDIR}/integration-plan.md"
	_write_integration_plan "${plan_file}"
	local sha
	sha=$(_compute_sha256 "${plan_file}")

	_write_boulder_for "${plan_file}"
	_write_all_ftypes "${sha}"

	run_hook "final-verification-evidence.sh" '{}'
	assert_success
}

# ---------------------------------------------------------------------------
# (b) Remove F3 → exit 2, stderr names final_verification_f3
# ---------------------------------------------------------------------------

@test "integration: missing F3 blocks Stop (exit 2) and names final_verification_f3 in stderr" {
	local plan_file="${BATS_TEST_TMPDIR}/integration-plan-f3.md"
	_write_integration_plan "${plan_file}"
	local sha
	sha=$(_compute_sha256 "${plan_file}")

	_write_boulder_for "${plan_file}"
	_write_all_ftypes "${sha}"
	_remove_ftype "final_verification_f3"

	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "final_verification_f3"
}
