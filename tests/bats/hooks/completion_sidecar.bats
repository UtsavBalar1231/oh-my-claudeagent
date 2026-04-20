#!/usr/bin/env bats
# Tests for compute_sidecar_path and check_sidecar_idempotency helpers in scripts/lib/common.sh

load '../test_helper'

# Resolve common.sh absolute path once, relative to this bats file's location.
_COMMON_SH="$(cd "$(dirname "${BATS_TEST_FILENAME}")/../../.." && pwd)/scripts/lib/common.sh"

# ---------------------------------------------------------------------------
# (a) Happy path: flat plan filename with explicit CLAUDE_PROJECT_ROOT
# ---------------------------------------------------------------------------

@test "compute_sidecar_path: flat plan path returns correct sidecar path" {
	result=$(CLAUDE_PROJECT_ROOT="/tmp/proj" bash -c "source \"${_COMMON_SH}\" < /dev/null; compute_sidecar_path '/home/user/.claude/plans/foo-bar.md'")
	[ "$result" = "/tmp/proj/.omca/notes/foo-bar-completion.md" ]
}

# ---------------------------------------------------------------------------
# (b) Basename correctness: nested plan path — only the filename matters
# ---------------------------------------------------------------------------

@test "compute_sidecar_path: nested plan path uses only basename" {
	local expected="$BATS_TEST_TMPDIR/myproject/.omca/notes/my-feature-plan-completion.md"
	result=$(CLAUDE_PROJECT_ROOT="$BATS_TEST_TMPDIR/myproject" bash -c "source \"${_COMMON_SH}\" < /dev/null; compute_sidecar_path '/home/user/.claude/plans/subdir/deep/my-feature-plan.md'")
	[ "$result" = "$expected" ]
}

# ---------------------------------------------------------------------------
# (c) Idempotency matching: existing sidecar with same SHA → safe (exit 0)
# ---------------------------------------------------------------------------

@test "check_sidecar_idempotency: matching SHA returns 0 (safe to overwrite)" {
	local sidecar="$BATS_TEST_TMPDIR/my-plan-completion.md"
	cat > "$sidecar" <<'EOF'
# Completion Sidecar
plan_sha256: ABC123
verdict: APPROVE
EOF
	bash -c "source \"${_COMMON_SH}\" < /dev/null; check_sidecar_idempotency \"$sidecar\" ABC123"
	[ "$?" -eq 0 ]
}

# ---------------------------------------------------------------------------
# (d) Idempotency mismatching: existing sidecar with different SHA → refuse (exit 1)
# ---------------------------------------------------------------------------

@test "check_sidecar_idempotency: mismatching SHA returns 1 (refuse overwrite)" {
	local sidecar="$BATS_TEST_TMPDIR/other-plan-completion.md"
	cat > "$sidecar" <<'EOF'
# Completion Sidecar
plan_sha256: ABC123
verdict: APPROVE
EOF
	local rc
	bash -c "source \"${_COMMON_SH}\" < /dev/null; check_sidecar_idempotency \"$sidecar\" XYZ789" && rc=$? || rc=$?
	[ "$rc" -eq 1 ]
}

# ---------------------------------------------------------------------------
# (e) Bonus: nonexistent sidecar → always safe (exit 0)
# ---------------------------------------------------------------------------

@test "check_sidecar_idempotency: nonexistent file returns 0 (safe)" {
	bash -c "source \"${_COMMON_SH}\" < /dev/null; check_sidecar_idempotency \"$BATS_TEST_TMPDIR/does-not-exist.md\" SOMESHA"
	[ "$?" -eq 0 ]
}

# ---------------------------------------------------------------------------
# (f) Bonus: existing sidecar with no SHA field → safe (exit 0)
# ---------------------------------------------------------------------------

@test "check_sidecar_idempotency: missing SHA field in existing file returns 0 (safe)" {
	local sidecar="$BATS_TEST_TMPDIR/no-sha-completion.md"
	cat > "$sidecar" <<'EOF'
# Completion Sidecar
verdict: APPROVE
notes: no sha recorded here
EOF
	bash -c "source \"${_COMMON_SH}\" < /dev/null; check_sidecar_idempotency \"$sidecar\" ANYHASH"
	[ "$?" -eq 0 ]
}

# ---------------------------------------------------------------------------
# (g) Bonus: SHA stored with quotes is stripped correctly — matches without quotes
# ---------------------------------------------------------------------------

@test "check_sidecar_idempotency: quoted SHA value is stripped and matched" {
	local sidecar="$BATS_TEST_TMPDIR/quoted-sha-completion.md"
	cat > "$sidecar" <<'EOF'
# Completion Sidecar
plan_sha256: "ABC123"
verdict: APPROVE
EOF
	bash -c "source \"${_COMMON_SH}\" < /dev/null; check_sidecar_idempotency \"$sidecar\" ABC123"
	[ "$?" -eq 0 ]
}
