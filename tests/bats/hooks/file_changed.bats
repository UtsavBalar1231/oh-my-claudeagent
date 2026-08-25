#!/usr/bin/env bats
# These cases prove the handler's filtering and logging only. Whether the platform
# ever dispatches a FileChanged payload to it is a property of hooks/hooks.json and
# is unobservable from here; see the registration note in file-changed-log.sh.

load '../test_helper'

info_log() {
	echo "$CLAUDE_PROJECT_ROOT/.omca/logs/hook-info.jsonl"
}

payload_for() {
	jq -nc --arg p "$1" --arg e "${2:-change}" \
		'{hook_event_name:"FileChanged", file_path:$p, event:$e}'
}

@test "file-changed-log: logs a change to the evidence ledger" {
	run_hook "file-changed-log.sh" \
		"$(payload_for "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json")"
	assert_success
	assert_output ""
	run jq -r 'select(.hook == "file-changed-log.sh") | .message' "$(info_log)"
	assert_output --partial "verification-evidence.json"
	assert_output --partial "out-of-band change"
}

@test "file-changed-log: logs the event kind for a deleted plan registry" {
	run_hook "file-changed-log.sh" \
		"$(payload_for "$CLAUDE_PROJECT_ROOT/.omca/state/boulder.json" "unlink")"
	assert_success
	run jq -r 'select(.hook == "file-changed-log.sh") | .message' "$(info_log)"
	assert_output --partial "out-of-band unlink"
	assert_output --partial "boulder.json"
}

@test "file-changed-log: ignores an unrelated file" {
	run_hook "file-changed-log.sh" "$(payload_for "$CLAUDE_PROJECT_ROOT/src/app.ts")"
	assert_success
	assert_output ""
	[ ! -s "$(info_log)" ]
}

@test "file-changed-log: ignores a same-named file outside .omca" {
	run_hook "file-changed-log.sh" "$(payload_for "$CLAUDE_PROJECT_ROOT/boulder.json")"
	assert_success
	[ ! -s "$(info_log)" ]
}

@test "file-changed-log: a payload with no file_path exits 0 and writes nothing" {
	run_hook "file-changed-log.sh" '{"hook_event_name":"FileChanged"}'
	assert_success
	assert_output ""
	[ ! -s "$(info_log)" ]
}

@test "file-changed-log: malformed stdin exits 0 and writes nothing" {
	run_hook "file-changed-log.sh" 'not json at all'
	assert_success
	assert_output ""
	[ ! -s "$(info_log)" ]
}

@test "file-changed-log: honors the OMCA_DISABLED_HOOKS kill switch" {
	OMCA_DISABLED_HOOKS="file-changed-log" run_hook "file-changed-log.sh" \
		"$(payload_for "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json")"
	assert_success
	[ ! -s "$(info_log)" ]
}
