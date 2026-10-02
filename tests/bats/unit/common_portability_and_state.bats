#!/usr/bin/env bats
# Unit tests for the portability and state-safety hardening in scripts/lib/common.sh:
# the timeout/gtimeout/cat probe, the fail-open signal on an unparseable payload,
# and the BSD-safe epoch_ns value probe.

load '../test_helper'

COMMON="scripts/lib/common.sh"

# Source common.sh in a fresh bash with an isolated state dir. HOOK_INPUT is
# preset so the stdin reader never runs; tests that exercise the reader build
# their own wrapper instead.
_lib() {
	run bash -c "
		cd '$CLAUDE_PLUGIN_ROOT'
		export HOOK_STATE_DIR='$BATS_TEST_TMPDIR/state' HOOK_LOG_DIR='$BATS_TEST_TMPDIR/logs'
		export HOOK_INPUT='{}'
		source '$COMMON'
		$1
	"
}

# A PATH containing every command the library needs except the ones named in $1.
# Built from symlinks so the excluded binaries are genuinely unresolvable rather
# than shadowed by a stub that would mask a wrong exit status.
_path_without() {
	local excluded=" $* "
	local dir="$BATS_TEST_TMPDIR/bin-$RANDOM"
	mkdir -p "$dir"
	local c p
	for c in bash jq cat date grep sed cut tr basename dirname mktemp mv rm mkdir \
		flock printf sha256sum shasum tail head sort wc awk timeout gtimeout sleep chmod \
		rmdir stat touch find; do
		[[ "${excluded}" == *" ${c} "* ]] && continue
		p=$(command -v "$c" 2>/dev/null) && ln -sf "$p" "$dir/$c"
	done
	printf '%s\n' "$dir"
}

# ─── a. stdin reader: timeout probe ──────────────────────────────────────────

@test "common.sh reader: no timeout on PATH still delivers the payload (gates stay live)" {
	local bin
	bin=$(_path_without timeout gtimeout)

	run env -i PATH="$bin" HOME="$HOME" CLAUDE_PROJECT_ROOT="$BATS_TEST_TMPDIR/p" \
		"$bin/bash" -c "
			cd '$CLAUDE_PLUGIN_ROOT'
			source '$COMMON'
			printf 'INPUT=[%s] TIMED_OUT=[%s]\n' \"\${HOOK_INPUT}\" \"\${HOOK_INPUT_TIMED_OUT}\"
		" <<< '{"tool_name":"Bash"}'

	assert_success
	assert_output 'INPUT=[{"tool_name":"Bash"}] TIMED_OUT=[0]'
}

@test "common.sh reader: gtimeout is used when timeout is absent" {
	local bin
	bin=$(_path_without timeout)
	# macOS coreutils installs the same binary under the g-prefixed name.
	ln -sf "$(command -v timeout)" "$bin/gtimeout"

	run env -i PATH="$bin" HOME="$HOME" CLAUDE_PROJECT_ROOT="$BATS_TEST_TMPDIR/p" \
		"$bin/bash" -c "
			cd '$CLAUDE_PLUGIN_ROOT'
			source '$COMMON'
			printf 'TIMED_OUT=[%s]\n' \"\${HOOK_INPUT_TIMED_OUT}\"
		" <<< '{"a":1}'

	assert_success
	assert_output 'TIMED_OUT=[0]'
}

# ─── b/c. fail-open signal ───────────────────────────────────────────────────

@test "common.sh reader: empty payload raises the fail-open signal" {
	run bash -c "
		cd '$CLAUDE_PLUGIN_ROOT'
		CLAUDE_PROJECT_ROOT='$BATS_TEST_TMPDIR/p' bash -c 'source \"$COMMON\"; printf \"%s\n\" \"\${HOOK_INPUT_TIMED_OUT}\"' < /dev/null
	"
	assert_success
	assert_output '1'
}

@test "common.sh reader: non-JSON payload raises the fail-open signal" {
	run bash -c "
		cd '$CLAUDE_PLUGIN_ROOT'
		printf 'not json at all' | CLAUDE_PROJECT_ROOT='$BATS_TEST_TMPDIR/p' \
			bash -c 'source \"$COMMON\"; printf \"%s\n\" \"\${HOOK_INPUT_TIMED_OUT}\"'
	"
	assert_success
	assert_output '1'
}

@test "common.sh reader: valid JSON payload leaves the fail-open signal clear" {
	run bash -c "
		cd '$CLAUDE_PLUGIN_ROOT'
		printf '{\"stop_hook_active\":false}' | CLAUDE_PROJECT_ROOT='$BATS_TEST_TMPDIR/p' \
			bash -c 'source \"$COMMON\"; printf \"%s\n\" \"\${HOOK_INPUT_TIMED_OUT}\"'
	"
	assert_success
	assert_output '0'
}

# ─── e. epoch_ns BSD probe ──────────────────────────────────────────────────

@test "epoch_ns: returns all-digit nanoseconds on GNU date" {
	_lib 'epoch_ns'
	assert_success
	[[ "$output" =~ ^[0-9]{19}$ ]]
}

@test "epoch_ns: BSD date printing a literal N falls back to scaled seconds" {
	local bin
	bin=$(_path_without date)
	# BSD/macOS `date` accepts +%s%N, exits 0, and echoes the N verbatim. An
	# exit-status probe never fires on this; only a value probe catches it.
	cat > "$bin/date" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "+%s%N" ]]; then printf '1785843035N\n'; exit 0; fi
if [[ "$1" == "+%s" ]]; then printf '1785843035\n'; exit 0; fi
exec /bin/date "$@"
EOF
	chmod +x "$bin/date"

	run env -i PATH="$bin" HOME="$HOME" CLAUDE_PROJECT_ROOT="$BATS_TEST_TMPDIR/p" HOOK_INPUT='{}' \
		"$bin/bash" -c "cd '$CLAUDE_PLUGIN_ROOT'; source '$COMMON'; epoch_ns"
	assert_success
	assert_output '1785843035000000000'
}

@test "hook_timing_log: a BSD-shaped start stamp does not fail the caller" {
	# The arithmetic used to abort with "value too great for base" and the hook
	# inherited exit 1, discarding an otherwise valid payload.
	_lib 'hook_timing_log "1785843035N"; echo "rc=$?"'
	assert_success
	assert_output 'rc=0'
}

@test "timing capture: no hook captures a start stamp via the exit-status-only date probe" {
	run grep -rn 'date +%s%N' "$CLAUDE_PLUGIN_ROOT/scripts"
	assert_output --partial 'lib/common.sh'
}

# ─── h. kill-switch `all` token ──────────────────────

@test "hook_is_disabled: the 'all' token disables every hook" {
	_lib 'OMCA_DISABLED_HOOKS=all hook_is_disabled drift-guard && echo disabled || echo enabled'
	assert_success
	assert_output 'disabled'
}

@test "hook_is_disabled: the '*' token disables every hook without globbing" {
	_lib 'OMCA_DISABLED_HOOKS="*" hook_is_disabled drift-guard && echo disabled || echo enabled'
	assert_success
	assert_output 'disabled'
}

@test "hook_is_disabled: 'all' inside a comma list still disables every hook" {
	_lib 'OMCA_DISABLED_HOOKS="comment-gate,all" hook_is_disabled drift-guard && echo disabled || echo enabled'
	assert_success
	assert_output 'disabled'
}

@test "hook_is_disabled: an unrelated list leaves the hook enabled" {
	_lib 'OMCA_DISABLED_HOOKS="comment-gate,post-edit" hook_is_disabled drift-guard && echo disabled || echo enabled'
	assert_success
	assert_output 'enabled'
}
