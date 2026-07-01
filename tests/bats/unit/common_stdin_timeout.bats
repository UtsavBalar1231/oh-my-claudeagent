#!/usr/bin/env bats
# Unit tests for the shared stdin reader's timeout behavior in scripts/lib/common.sh
# (Task 10: 5s timeout on `cat`, HOOK_INPUT_TIMED_OUT signal, ${HOOK_INPUT+x} seam preserved).

load '../test_helper'

@test "common.sh reader: stdin timeout yields empty HOOK_INPUT (not partial) and TIMED_OUT=1" {
	local wrapper="$BATS_TEST_TMPDIR/timeout-hook.sh"
	cat > "$wrapper" <<'EOF'
#!/usr/bin/env bash
source "${COMMON_SH}"
printf 'HOOK_INPUT=[%s] TIMED_OUT=[%s]\n' "${HOOK_INPUT}" "${HOOK_INPUT_TIMED_OUT}"
EOF
	chmod +x "$wrapper"

	# <(sleep 10) keeps the pipe's write end open with no data for 10s — the
	# reader's 5s timeout fires first, proving the timeout path (not a race
	# with a fast producer) and that no partial data leaks through.
	run bash -c "COMMON_SH='$CLAUDE_PLUGIN_ROOT/scripts/lib/common.sh' HOOK_PROJECT_ROOT='$CLAUDE_PROJECT_ROOT' bash '$wrapper' < <(sleep 10)"
	assert_success
	assert_output "HOOK_INPUT=[] TIMED_OUT=[1]"
}

@test "common.sh reader: preset HOOK_INPUT skips the timeout branch (seam preserved)" {
	local wrapper="$BATS_TEST_TMPDIR/seam-hook.sh"
	cat > "$wrapper" <<'EOF'
#!/usr/bin/env bash
source "${COMMON_SH}"
printf 'HOOK_INPUT=[%s] TIMED_OUT=[%s]\n' "${HOOK_INPUT}" "${HOOK_INPUT_TIMED_OUT:-0}"
EOF
	chmod +x "$wrapper"

	# HOOK_INPUT preset (as bats/test fixtures do via <<< redirection or direct
	# export) must bypass `timeout 5 cat` entirely — no stdin read, no delay.
	run bash -c "COMMON_SH='$CLAUDE_PLUGIN_ROOT/scripts/lib/common.sh' HOOK_PROJECT_ROOT='$CLAUDE_PROJECT_ROOT' HOOK_INPUT='{\"foo\":1}' bash '$wrapper'"
	assert_success
	assert_output 'HOOK_INPUT=[{"foo":1}] TIMED_OUT=[0]'
}
