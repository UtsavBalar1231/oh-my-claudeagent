#!/usr/bin/env bats
# Behavioral tests for stop-failure-log.sh

load '../test_helper'

info_log() {
	echo "$CLAUDE_PROJECT_ROOT/.omca/logs/hook-info.jsonl"
}

@test "stop-failure: records error and error_details" {
	local payload
	payload=$(jq -nc '{
		hook_event_name: "StopFailure",
		error: "rate_limit",
		error_details: "429 Too Many Requests"
	}')

	run_hook "stop-failure-log.sh" "$payload"
	assert_success

	assert [ -f "$(info_log)" ]

	local msg
	msg=$(tail -1 "$(info_log)" | jq -r '.message')
	[[ "$msg" == *"rate_limit"* ]]
	[[ "$msg" == *"429 Too Many Requests"* ]]

	local hook
	hook=$(tail -1 "$(info_log)" | jq -r '.hook')
	[ "$hook" = "stop-failure-log.sh" ]
}

@test "stop-failure: records error when error_details is absent" {
	local payload
	payload=$(jq -nc '{ hook_event_name: "StopFailure", error: "overloaded" }')

	run_hook "stop-failure-log.sh" "$payload"
	assert_success

	local msg
	msg=$(tail -1 "$(info_log)" | jq -r '.message')
	[[ "$msg" == *"overloaded"* ]]
}

@test "stop-failure: writes nothing when error is absent" {
	local payload
	payload=$(jq -nc '{ hook_event_name: "StopFailure" }')

	run_hook "stop-failure-log.sh" "$payload"
	assert_success

	assert [ ! -s "$(info_log)" ]
}

@test "stop-failure: emits no output, so it can never influence the turn" {
	local payload
	payload=$(jq -nc '{ hook_event_name: "StopFailure", error: "server_error" }')

	run_hook "stop-failure-log.sh" "$payload"
	assert_success
	[ -z "$output" ]
}

@test "stop-failure: kill switch suppresses the log entry" {
	export OMCA_DISABLED_HOOKS="stop-failure-log"

	local payload
	payload=$(jq -nc '{ hook_event_name: "StopFailure", error: "rate_limit" }')

	run_hook "stop-failure-log.sh" "$payload"
	assert_success

	assert [ ! -s "$(info_log)" ]
}
