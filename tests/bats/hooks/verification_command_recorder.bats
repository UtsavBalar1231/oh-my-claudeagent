#!/usr/bin/env bats
load '../test_helper'

# The recorder's polarity is inverted against the gate it feeds: a runner it fails to
# recognise records nothing and the gate stays silent, so a miss is a false negative,
# never a false block. These cases pin both directions of that tradeoff.

SLOT_REL=".omca/state/last-verification-command.json"

_record() {
	run_hook "verification-command-recorder.sh" "$(jq -nc --arg c "$1" '{tool_input: {command: $c}}')"
}

_slot() {
	cat "$CLAUDE_PROJECT_ROOT/$SLOT_REL"
}

_slot_exists() {
	[ -f "$CLAUDE_PROJECT_ROOT/$SLOT_REL" ]
}

# ─── Recognised runners ──────────────────────────────────────────────────────

@test "recorder: bare 'just test' records a slot" {
	_record "just test"
	assert_success
	[ "$(jq -r '.command' <<< "$(_slot)")" = "just test" ]
	[ "$(jq -r '.session_id' <<< "$(_slot)")" = "$CLAUDE_SESSION_ID" ]
}

@test "recorder: a runner after && is anchored and records" {
	_record "cd servers && uv run --project . pytest -q"
	assert_success
	_slot_exists
}

@test "recorder: each ecosystem runner in the list records" {
	local c
	for c in "just ci" "npm test" "pnpm run lint" "cargo clippy" "go vet ./..." \
		"make check" "bats tests/bats" "tsc --noEmit" "ruff check servers/" "shellcheck scripts/x.sh"; do
		rm -f "$CLAUDE_PROJECT_ROOT/$SLOT_REL"
		_record "$c"
		_slot_exists || fail "no slot recorded for: $c"
	done
}

# ─── Mentions are not invocations ────────────────────────────────────────────

@test "recorder: a runner inside a double-quoted span records nothing" {
	_record 'echo "npm test"'
	assert_success
	! _slot_exists
}

@test "recorder: a runner inside a single-quoted span records nothing" {
	_record "printf '%s' 'just test'"
	assert_success
	! _slot_exists
}

@test "recorder: an unrecognised command records nothing" {
	_record "ls -la"
	assert_success
	! _slot_exists
}

@test "recorder: a mid-command flag value is not an invocation" {
	_record "grep --include=pytest -r x ."
	assert_success
	! _slot_exists
}

# ─── Single-slot overwrite policy ────────────────────────────────────────────

@test "recorder: an unsatisfied slot survives a later verification" {
	_record "just test"
	local first
	first=$(jq -r '.command' <<< "$(_slot)")
	_record "just lint"
	[ "$(jq -r '.command' <<< "$(_slot)")" = "$first" ]
}

@test "recorder: a satisfied slot is replaced by a later verification" {
	_record "just test"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/evidence"
	printf '%s' '{"entries":[]}' > "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json"
	touch -d "1 minute" "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json"
	_record "just lint"
	[ "$(jq -r '.command' <<< "$(_slot)")" = "just lint" ]
}

# ─── exit_code is display-only ───────────────────────────────────────────────

@test "recorder: exitCode is carried through when present" {
	run_hook "verification-command-recorder.sh" \
		'{"tool_input":{"command":"just test"},"tool_response":{"exitCode":1}}'
	[ "$(jq -r '.exit_code' <<< "$(_slot)")" = "1" ]
}

@test "recorder: a non-object tool_response degrades exit_code to null" {
	run_hook "verification-command-recorder.sh" \
		'{"tool_input":{"command":"just test"},"tool_response":"some text"}'
	assert_success
	[ "$(jq -r '.exit_code' <<< "$(_slot)")" = "null" ]
}

# ─── Kill switch and malformed input ─────────────────────────────────────────

@test "recorder: OMCA_DISABLED_HOOKS listing this hook records nothing" {
	OMCA_DISABLED_HOOKS="verification-command-recorder" _record "just test"
	assert_success
	! _slot_exists
}

@test "recorder: a payload with no command exits 0 and records nothing" {
	run_hook "verification-command-recorder.sh" '{"tool_input":{}}'
	assert_success
	! _slot_exists
}
