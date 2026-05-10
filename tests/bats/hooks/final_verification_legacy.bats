#!/usr/bin/env bats
# Behavioral tests for final-verification-evidence.sh — C-9 has_ftype legacy fallback removal.
# Verifies that evidence from prior plans (different SHAs) no longer satisfies F1-F4,
# and that the snippet-based SHA match path still works for legacy-format entries.

load '../test_helper'

NOW=$(date +%s)

SHA_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

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

# Case 1: prior-plan SHAs don't match current SHA-C → demand fires (legacy fallback gone)

@test "final-verification C-9: legacy F1 SHA-A + modern F2 SHA-B don't satisfy current SHA-C (exit 2)" {
	local plan_file="${BATS_TEST_TMPDIR}/plan-c.md"
	_write_complete_plan "${plan_file}"

	# Current plan SHA (SHA-C) is derived from the actual plan file
	local sha_c
	sha_c=$(sha256sum "${plan_file}" | awk '{print $1}')

	_write_boulder "${plan_file}"

	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

	# F1: legacy (snippet only, SHA-A); F2: modern (.plan_sha256 SHA-B); F3/F4 absent
	local entries
	entries=$(jq -n \
		--arg ts "${ts}" \
		--arg sha_a "${SHA_A}" \
		--arg sha_b "${SHA_B}" \
		'[
			{
				"type": "final_verification_f1",
				"command": "oracle: APPROVE",
				"exit_code": 0,
				"output_snippet": ("plan_sha256:" + $sha_a + " verdict:APPROVE"),
				"timestamp": $ts
			},
			{
				"type": "final_verification_f2",
				"command": "oracle: APPROVE",
				"exit_code": 0,
				"plan_sha256": $sha_b,
				"output_snippet": "verdict:APPROVE",
				"timestamp": $ts
			}
		]')
	write_state "verification-evidence.json" "{\"entries\":${entries}}"

	# Write marker so the hook doesn't short-circuit via C-8
	write_state "pending-final-verify.json" \
		"{\"plan_path\":\"${plan_file}\",\"plan_sha256\":\"${sha_c}\",\"marked_at\":${NOW},\"session_id\":\"bats-test-session\"}"

	export CLAUDE_SESSION_ID="bats-test-session"
	run_hook "final-verification-evidence.sh" '{}'
	[ "$status" -eq 2 ]
	echo "$output" | grep -qi "F1-F4 evidence missing"
}

# Case 2: legacy F1 snippet matches current SHA-C + modern F2-F4 → no demand (snippet path works)

@test "final-verification C-9: legacy F1 snippet SHA-C + modern F2-F4 SHA-C satisfies all (exit 0)" {
	local plan_file="${BATS_TEST_TMPDIR}/plan-c2.md"
	_write_complete_plan "${plan_file}"

	# Compute SHA-C from the actual plan file
	local sha_c
	sha_c=$(sha256sum "${plan_file}" | awk '{print $1}')

	_write_boulder "${plan_file}"

	local ts
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

	# F1: legacy format — no plan_sha256 field, but snippet matches SHA-C (current plan)
	# F2/F3/F4: modern format — first-class plan_sha256 = SHA-C
	local entries
	entries=$(jq -n \
		--arg ts "${ts}" \
		--arg sha_c "${sha_c}" \
		'[
			{
				"type": "final_verification_f1",
				"command": "oracle: APPROVE",
				"exit_code": 0,
				"output_snippet": ("plan_sha256:" + $sha_c + " verdict:APPROVE"),
				"timestamp": $ts
			},
			{
				"type": "final_verification_f2",
				"command": "oracle: APPROVE",
				"exit_code": 0,
				"plan_sha256": $sha_c,
				"output_snippet": "verdict:APPROVE",
				"timestamp": $ts
			},
			{
				"type": "final_verification_f3",
				"command": "oracle: APPROVE",
				"exit_code": 0,
				"plan_sha256": $sha_c,
				"output_snippet": "verdict:APPROVE",
				"timestamp": $ts
			},
			{
				"type": "final_verification_f4",
				"command": "oracle: APPROVE",
				"exit_code": 0,
				"plan_sha256": $sha_c,
				"output_snippet": "verdict:APPROVE",
				"timestamp": $ts
			}
		]')
	write_state "verification-evidence.json" "{\"entries\":${entries}}"

	# Write marker so the hook doesn't short-circuit via C-8
	write_state "pending-final-verify.json" \
		"{\"plan_path\":\"${plan_file}\",\"plan_sha256\":\"${sha_c}\",\"marked_at\":${NOW},\"session_id\":\"bats-test-session\"}"

	export CLAUDE_SESSION_ID="bats-test-session"
	run_hook "final-verification-evidence.sh" '{}'
	assert_success
	[ "$output" = "{}" ]
}
