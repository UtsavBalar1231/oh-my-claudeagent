#!/usr/bin/env bats
# Tests for the inlined sidecar-path and SHA-match logic used in final-verification-evidence.sh.
# compute_sidecar_path, check_sidecar_idempotency, and sidecar_sha_matches were removed from
# scripts/lib/common.sh (M-1 / M-2); their behaviour is verified via final_verification_evidence.bats.

load '../test_helper'

# ---------------------------------------------------------------------------
# Sidecar path expansion — verify the inlined bash expression is correct.
# ---------------------------------------------------------------------------

@test "sidecar path: flat plan filename produces expected path" {
	local plan="/home/user/.claude/plans/foo-bar.md"
	local root="/tmp/proj"
	local expected="${root}/.omca/notes/foo-bar-completion.md"
	local result
	result="${root}/.omca/notes/$(basename "${plan}" .md)-completion.md"
	[ "$result" = "$expected" ]
}

@test "sidecar path: nested plan path uses only basename" {
	local plan="/home/user/.claude/plans/subdir/deep/my-feature-plan.md"
	local root="$BATS_TEST_TMPDIR/myproject"
	local expected="${root}/.omca/notes/my-feature-plan-completion.md"
	local result
	result="${root}/.omca/notes/$(basename "${plan}" .md)-completion.md"
	[ "$result" = "$expected" ]
}
