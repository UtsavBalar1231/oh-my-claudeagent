#!/usr/bin/env bats
load '../test_helper'

# classifierContext is model-facing input to a permission decision, so it must ride the
# same mention-versus-invocation decision the slot write rides, and it must not change
# what the recorder records.

SLOT_REL=".omca/state/last-verification-command.json"

_record() {
	run_hook "verification-command-recorder.sh" "$(jq -nc --arg c "$1" '{tool_input: {command: $c}}')"
}

_note() {
	jq -r '.hookSpecificOutput.classifierContext // empty' <<< "$output"
}

_slot_exists() {
	[ -f "$CLAUDE_PROJECT_ROOT/$SLOT_REL" ]
}

@test "classifier note: a recognised runner emits the note and still records a slot" {
	_record "just test"
	assert_success
	[ -n "$(_note)" ]
	[ "$(jq -r '.hookSpecificOutput.hookEventName' <<< "$output")" = "PostToolUse" ]
	_slot_exists
	[ "$(jq -r '.command' < "$CLAUDE_PROJECT_ROOT/$SLOT_REL")" = "just test" ]
}

@test "classifier note: an unrecognised command emits no note and records no slot" {
	_record "ls -la"
	assert_success
	[ -z "$(_note)" ]
	[ -z "$output" ]
	! _slot_exists
}

@test "classifier note: a quoted mention emits no note and records no slot" {
	_record 'echo "just test"'
	assert_success
	[ -z "$(_note)" ]
	! _slot_exists
}

@test "classifier note: the note is a single short assertion within the platform cap" {
	_record "just ci"
	assert_success
	local note
	note=$(_note)
	# 2000 chars is the platform's per-call cap, shared across every hook answering the call.
	[ "${#note}" -lt 2000 ]
	[ "$(printf '%s' "$note" | wc -l)" -eq 0 ]
}

@test "classifier note: the disabled hook emits nothing" {
	OMCA_DISABLED_HOOKS="verification-command-recorder" _record "just test"
	assert_success
	[ -z "$output" ]
	! _slot_exists
}
