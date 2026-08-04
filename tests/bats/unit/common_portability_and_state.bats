#!/usr/bin/env bats
# Unit tests for the portability and state-safety hardening in scripts/lib/common.sh:
# the timeout/gtimeout/cat probe, the fail-open signal on an unparseable payload,
# _sha256 fallback, the BSD-safe _epoch_ns value probe, concurrency-safe and
# self-healing JSON read-modify-write, and the Stop-event block ledger.

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
		flock printf sha256sum shasum tail head sort wc awk timeout gtimeout sleep chmod; do
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

@test "common.sh reader: no timeout on PATH keeps a deny gate denying" {
	local bin
	bin=$(_path_without timeout gtimeout)
	local payload='{"tool_name":"Bash","tool_input":{"command":"sed -n 1,5p foo.txt"}}'

	run env -i PATH="$bin" HOME="$HOME" CLAUDE_PROJECT_ROOT="$BATS_TEST_TMPDIR/p" \
		"$bin/bash" "$CLAUDE_PLUGIN_ROOT/scripts/sed-grep-deny.sh" <<< "$payload"

	# Before the probe existed, `timeout` resolved to nothing, HOOK_INPUT stayed
	# empty and the hook produced no decision — every deny gate silently inert.
	# The deny is carried by the decision payload, not by an exit code: exit 2 is
	# ignored on PermissionRequest.
	assert_success
	assert_output --partial '"behavior":"deny"'
	assert_output --partial 'denied'
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

# ─── d. _sha256 ──────────────────────────────────────────────────────────────

@test "_sha256: matches sha256sum for a known input" {
	_lib 'printf "abc" | _sha256'
	assert_success
	assert_output 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
}

@test "_sha256: falls back to shasum when sha256sum is absent" {
	local bin
	bin=$(_path_without sha256sum)
	run env -i PATH="$bin" HOME="$HOME" CLAUDE_PROJECT_ROOT="$BATS_TEST_TMPDIR/p" HOOK_INPUT='{}' \
		"$bin/bash" -c "cd '$CLAUDE_PLUGIN_ROOT'; source '$COMMON'; printf 'abc' | _sha256"
	assert_success
	assert_output 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
}

@test "_sha256: with no digest tool prints the sentinel, never an empty string" {
	local bin
	bin=$(_path_without sha256sum shasum)
	run env -i PATH="$bin" HOME="$HOME" CLAUDE_PROJECT_ROOT="$BATS_TEST_TMPDIR/p" HOOK_INPUT='{}' \
		"$bin/bash" -c "cd '$CLAUDE_PLUGIN_ROOT'; source '$COMMON'; printf 'abc' | _sha256"
	assert_success
	assert_output 'no-digest'
	refute_output ''
}

# ─── e. _epoch_ns BSD probe ──────────────────────────────────────────────────

@test "_epoch_ns: returns all-digit nanoseconds on GNU date" {
	_lib '_epoch_ns'
	assert_success
	[[ "$output" =~ ^[0-9]{19}$ ]]
}

@test "_epoch_ns: BSD date printing a literal N falls back to scaled seconds" {
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
		"$bin/bash" -c "cd '$CLAUDE_PLUGIN_ROOT'; source '$COMMON'; _epoch_ns"
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

# ─── f. concurrency-safe, self-healing RMW ───────────────────────────────────

@test "error_count_bump: N=5 concurrent bumps preserve every bump" {
	run bash -c "
		cd '$CLAUDE_PLUGIN_ROOT'
		for i in 1 2 3 4 5; do
			(
				export HOOK_STATE_DIR='$BATS_TEST_TMPDIR/state' HOOK_LOG_DIR='$BATS_TEST_TMPDIR/logs' HOOK_INPUT='{}'
				source '$COMMON'
				error_count_bump concurrent \"err\$i\" > /dev/null
			) &
		done
		wait
		jq -r '.concurrent.count' '$BATS_TEST_TMPDIR/state/error-counts.json'
	"
	assert_success
	assert_output '5'
}

@test "error_count_bump: a corrupt error-counts.json self-heals to a valid file" {
	mkdir -p "$BATS_TEST_TMPDIR/state"
	printf 'THIS IS NOT JSON {' > "$BATS_TEST_TMPDIR/state/error-counts.json"

	_lib 'error_count_bump healme "boom"'
	assert_success
	assert_output '1'

	run jq -r '.healme.count' "$BATS_TEST_TMPDIR/state/error-counts.json"
	assert_success
	assert_output '1'
}

@test "error_count_bump: a zero-byte error-counts.json self-heals" {
	mkdir -p "$BATS_TEST_TMPDIR/state"
	: > "$BATS_TEST_TMPDIR/state/error-counts.json"

	# `jq . </dev/null` exits 0 and prints nothing, so an exit-status-only guard
	# let the empty string through and the model literally received "Retry: /3".
	_lib 'error_count_bump zerobyte "boom"'
	assert_success
	assert_output '1'

	run jq -r '.zerobyte.count' "$BATS_TEST_TMPDIR/state/error-counts.json"
	assert_success
	assert_output '1'
}

@test "error_count_bump: a cross-device TMPDIR does not drop bumps" {
	# The temp file now lands beside the target, so the mv is a rename. Pointing
	# TMPDIR at a non-existent path proves the write no longer depends on it.
	run bash -c "
		cd '$CLAUDE_PLUGIN_ROOT'
		export HOOK_STATE_DIR='$BATS_TEST_TMPDIR/state' HOOK_LOG_DIR='$BATS_TEST_TMPDIR/logs' HOOK_INPUT='{}'
		export TMPDIR='/nonexistent-tmpdir'
		source '$COMMON'
		error_count_bump xdev 'boom'
	"
	assert_success
	assert_output '1'
}

@test "mark_mode_announced: a corrupt active-modes.json self-heals" {
	mkdir -p "$BATS_TEST_TMPDIR/state"
	printf '{{{ broken' > "$BATS_TEST_TMPDIR/state/active-modes.json"

	_lib 'CURRENT_SESSION=sid-1 mark_mode_announced plan'
	assert_success

	run jq -r '.plan.session_id' "$BATS_TEST_TMPDIR/state/active-modes.json"
	assert_success
	assert_output 'sid-1'
}

# ─── g. Stop-event block ledger ──────────────────────────────────────────────

@test "stop_block_allowed: allows up to the hard cap, then refuses" {
	_lib 'for i in 1 2 3 4 5 6 7; do stop_block_allowed drift-guard && echo allow || echo cap; done'
	assert_success
	assert_line --index 0 'allow'
	assert_line --index 4 'allow'
	assert_line --index 5 'cap'
	assert_line --index 6 'cap'
}

@test "stop_block_allowed: caps each gate independently" {
	_lib 'for i in 1 2 3 4 5; do stop_block_allowed gate-a >/dev/null; done
	      stop_block_allowed gate-a && echo a-allow || echo a-cap
	      stop_block_allowed gate-b && echo b-allow || echo b-cap'
	assert_success
	assert_line --index 0 'a-cap'
	assert_line --index 1 'b-allow'
}

@test "stop_blocks_reset: clears the ledger so the budget is full again" {
	_lib 'for i in 1 2 3 4 5; do stop_block_allowed g >/dev/null; done
	      stop_blocks_reset
	      stop_block_allowed g && echo allow || echo cap'
	assert_success
	assert_output 'allow'
}

@test "stop_block_allowed: an unwritable state dir fails open (refuses to block)" {
	mkdir -p "$BATS_TEST_TMPDIR/state"
	chmod a-w "$BATS_TEST_TMPDIR/state"
	_lib 'stop_block_allowed drift-guard && echo allow || echo fail-open'
	chmod u+w "$BATS_TEST_TMPDIR/state"
	assert_success
	assert_output 'fail-open'
}

@test "stop_block_allowed: a corrupt ledger fails open and heals for the next Stop" {
	mkdir -p "$BATS_TEST_TMPDIR/state"
	printf 'not json' > "$BATS_TEST_TMPDIR/state/stop-blocks.json"

	_lib 'stop_block_allowed drift-guard && echo allow || echo fail-open'
	assert_success
	assert_output 'fail-open'

	run jq -e . "$BATS_TEST_TMPDIR/state/stop-blocks.json"
	assert_success
}

@test "stop_block_allowed: no jq fails open" {
	local bin
	bin=$(_path_without jq)
	run env -i PATH="$bin" HOME="$HOME" HOOK_STATE_DIR="$BATS_TEST_TMPDIR/state" \
		HOOK_LOG_DIR="$BATS_TEST_TMPDIR/logs" HOOK_INPUT='{}' \
		"$bin/bash" -c "cd '$CLAUDE_PLUGIN_ROOT'; source '$COMMON'; stop_block_allowed g && echo allow || echo fail-open"
	assert_success
	assert_output 'fail-open'
}

# ─── h. kill-switch `all` token and block_exit fallback ──────────────────────

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
	_lib 'OMCA_DISABLED_HOOKS="write-guard,all" hook_is_disabled drift-guard && echo disabled || echo enabled'
	assert_success
	assert_output 'disabled'
}

@test "hook_is_disabled: an unrelated list leaves the hook enabled" {
	_lib 'OMCA_DISABLED_HOOKS="write-guard,post-edit" hook_is_disabled drift-guard && echo disabled || echo enabled'
	assert_success
	assert_output 'enabled'
}

@test "block_exit: the static fallback names the gate and the bypass" {
	local gate="$BATS_TEST_TMPDIR/my-stop-gate.sh"
	cat > "$gate" <<EOF
#!/usr/bin/env bash
export HOOK_STATE_DIR='$BATS_TEST_TMPDIR/state' HOOK_LOG_DIR='$BATS_TEST_TMPDIR/logs' HOOK_INPUT='{}'
source '$CLAUDE_PLUGIN_ROOT/$COMMON'
# Force the encode failure the fallback exists for.
jq() { return 1; }
block_exit "some reason"
EOF
	run bash "$gate"
	assert_success
	assert_output --partial 'my-stop-gate'
	assert_output --partial 'OMCA_DISABLED_HOOKS'
	run jq -e '.decision == "block" and (.reason | length > 0)' <<< "$output"
	assert_success
}
