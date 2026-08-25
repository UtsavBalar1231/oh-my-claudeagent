#!/usr/bin/env bats
# Portability coverage for hooks that reach for tools stock macOS does not ship:
# sha256sum (tool-loop-detector, comment-checker, context-injector) and flock
# (post-edit). Each case runs the hook under a PATH that contains the coreutils
# it needs and neither digest tool nor flock, which is what a mac without
# coreutils looks like from inside a hook.

load '../test_helper'

# _minimal_path — builds a PATH directory holding only the listed commands, so a
# hook can be run with a specific tool provably absent. Symlinks rather than
# copies: the real binaries still resolve their own data files.
_minimal_path() {
	local sandbox="$BATS_TEST_TMPDIR/nodep"
	mkdir -p "$sandbox"
	local cmd resolved
	for cmd in bash sh jq date mktemp mkdir mv rm cp ln cat cut tr wc sed awk grep head tail sort stat realpath find diff timeout python3 touch env dirname basename uname id; do
		resolved=$(command -v "$cmd" 2>/dev/null) && ln -sf "$resolved" "$sandbox/$cmd"
	done
	printf '%s\n' "$sandbox"
}

_run_without_digest() {
	local script="$1" payload="$2" sandbox
	sandbox=$(_minimal_path)
	run env PATH="$sandbox" bash "$CLAUDE_PLUGIN_ROOT/scripts/$script" <<< "$payload"
}

@test "sandbox PATH genuinely lacks sha256sum, shasum and flock" {
	local sandbox
	sandbox=$(_minimal_path)
	run env PATH="$sandbox" bash -c 'command -v sha256sum shasum flock'
	assert_failure
	run env PATH="$sandbox" bash -c 'command -v jq >/dev/null && echo ok'
	assert_output 'ok'
}

# ── tool-loop-detector: no digest tool ────────────────────────────────────────
# Regression: an unguarded `sha256sum` produced an empty signature, which desynced
# the `@tsv` state read (default IFS eats the leading empty field) and pinned the
# streak at 1, so the detector could never reach its fire count.

# The detector reads a PostToolBatch tool_calls array; a non-empty batch is what
# carries the payload past the early exit into the digest path under test.
_loop_batch_payload='{"hook_event_name":"PostToolBatch","prompt_id":"p1","tool_calls":[{"tool_name":"Bash","tool_input":{"command":"ls -la"}}]}'

@test "tool-loop-detector: without a digest tool it writes no state and never fires" {
	local i
	for i in 1 2 3 4; do
		_run_without_digest "tool-loop-detector.sh" "$_loop_batch_payload"
		assert_success
		assert_output ''
	done
	[ ! -f "$CLAUDE_PROJECT_ROOT/.omca/state/tool-loop-window.json" ]
}

@test "tool-loop-detector: with a digest tool the streak still fires on the third call" {
	run_hook "tool-loop-detector.sh" "$_loop_batch_payload"
	run_hook "tool-loop-detector.sh" "$_loop_batch_payload"
	run_hook "tool-loop-detector.sh" "$_loop_batch_payload"
	assert_success
	[[ "$(get_context)" == *"3 times in a row"* ]]
	[ "$(jq -r '.count' "$CLAUDE_PROJECT_ROOT/.omca/state/tool-loop-window.json")" = "3" ]
}

# ── comment-checker: no digest tool ───────────────────────────────────────────
# Regression: an empty signature equalled the empty default of the stored
# signature, so the deny-once loop breaker opened the tier-2 gate on calls it had
# never seen. With no usable signature the gate advises instead, which keeps the
# retry-loop protection the breaker exists to provide.

@test "comment-checker: without a digest tool a tier-2 finding advises, never denies" {
	local payload
	payload=$(jq -nc '{tool_name:"Write",tool_input:{file_path:"/proj/a.py",content:"# ----------------------------------------\ndef f():\n    pass\n"}}')
	local i
	for i in 1 2 3; do
		OMCA_COMMENT_GATE=deny _run_without_digest "comment-checker.sh" "$payload"
		assert_success
		refute_output --partial '"deny"'
	done
}

@test "comment-checker: with a digest tool the first tier-2 finding still denies" {
	local payload
	payload=$(jq -nc '{tool_name:"Write",tool_input:{file_path:"/proj/a.py",content:"# ----------------------------------------\ndef f():\n    pass\n"}}')
	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output --partial '"deny"'
	# The signature stored for the loop breaker must be a real digest, never the
	# sentinel: a sentinel would match every later finding and hold the gate open.
	local sig
	sig=$(jq -r '.signature' "$CLAUDE_PROJECT_ROOT/.omca/state/comment-gate-window.json")
	[[ "$sig" =~ ^[0-9a-f]{16}$ ]]
}

# ── context-injector: no digest tool ──────────────────────────────────────────
# Regression: an empty rule hash froze the cache key, so an edited rule kept
# matching its old key and never re-injected.

_seed_rule() {
	printf '# pattern: *.py\n%s\n' "$1" > "$CLAUDE_PROJECT_ROOT/.omca/rules/r.md"
	printf 'x=1\n' > "$CLAUDE_PROJECT_ROOT/f.py"
}

_inject_payload() {
	jq -nc --arg p "$CLAUDE_PROJECT_ROOT/f.py" '{tool_name:"Read",tool_input:{file_path:$p}}'
}

@test "context-injector: without a digest tool an edited rule still re-injects" {
	_seed_rule "RULE BODY v1"
	_run_without_digest "context-injector.sh" "$(_inject_payload)"
	assert_success
	[[ "$(get_context)" == *"RULE BODY v1"* ]]

	_seed_rule "RULE BODY v2"
	_run_without_digest "context-injector.sh" "$(_inject_payload)"
	assert_success
	[[ "$(get_context)" == *"RULE BODY v2"* ]]

	# No sentinel may be written as if it were a digest.
	run jq -e '[keys[] | select(startswith("rule:"))] | length == 0' \
		"$CLAUDE_PROJECT_ROOT/.omca/state/injected-context-dirs.json"
	assert_success
}

@test "context-injector: with a digest tool an unchanged rule injects once, an edited one re-injects" {
	_seed_rule "RULE BODY v1"
	run_hook "context-injector.sh" "$(_inject_payload)"
	[[ "$(get_context)" == *"RULE BODY v1"* ]]

	run_hook "context-injector.sh" "$(_inject_payload)"
	[[ "$(get_context)" != *"RULE BODY v1"* ]]

	_seed_rule "RULE BODY v2"
	run_hook "context-injector.sh" "$(_inject_payload)"
	[[ "$(get_context)" == *"RULE BODY v2"* ]]
}

# ── post-edit: no flock ───────────────────────────────────────────────────────
# Regression: an unguarded `flock` exited 127 inside the subshell, the update was
# skipped entirely, and rc=127 was logged as "flock timeout" — an error line for
# a lock that was never contended.

@test "post-edit: without flock the recent-edits update still happens" {
	local payload
	payload=$(jq -nc '{tool_name:"Write",tool_input:{file_path:"/proj/x.rs"},tool_response:{success:true}}')
	_run_without_digest "post-edit.sh" "$payload"
	assert_success
	run jq -r '.files["/proj/x.rs"]' "$CLAUDE_PROJECT_ROOT/.omca/state/recent-edits.json"
	assert_success
	refute_output 'null'
}

@test "post-edit: without flock nothing is logged as a flock timeout" {
	local payload
	payload=$(jq -nc '{tool_name:"Write",tool_input:{file_path:"/proj/x.rs"},tool_response:{success:true}}')
	_run_without_digest "post-edit.sh" "$payload"
	assert_success
	if [[ -f "$CLAUDE_PROJECT_ROOT/.omca/logs/hook-errors.jsonl" ]]; then
		run grep -c 'flock' "$CLAUDE_PROJECT_ROOT/.omca/logs/hook-errors.jsonl"
		assert_output '0'
	fi
}
