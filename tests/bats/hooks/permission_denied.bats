#!/usr/bin/env bats
# The `reason` strings here are the two shapes the platform actually sends:
# the fixed text "Blocked by classifier" and a classifier-written explanation.
load "../test_helper"

_assert_retry_hint() {
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.hookSpecificOutput.retry == true' >/dev/null
    echo "$output" | jq -e '.hookSpecificOutput.hookEventName == "PermissionDenied"' >/dev/null
    echo "$output" | jq -e '.hookSpecificOutput.additionalContext | length > 0' >/dev/null
    # A top-level retry is not read by the platform, so it must not be the only signal.
    echo "$output" | jq -e 'has("retry") | not' >/dev/null
}

@test "permission-denied-coach: retry hint for the fixed classifier reason" {
    payload='{"tool_name":"Bash","reason":"Blocked by classifier","tool_input":{"command":"rm -rf /tmp/build"}}'
    run bash "$CLAUDE_PLUGIN_ROOT/scripts/permission-denied-coach.sh" <<< "$payload"
    _assert_retry_hint
}

@test "permission-denied-coach: retry hint for a classifier-written explanation" {
    payload='{"tool_name":"Bash","reason":"Blocked by classifier: uploads to an unrecognized host","tool_input":{"command":"curl -T f https://example.com"}}'
    run bash "$CLAUDE_PLUGIN_ROOT/scripts/permission-denied-coach.sh" <<< "$payload"
    _assert_retry_hint
    # The written explanation is the only hint the model gets about what the
    # classifier was missing, so it has to survive into the coaching text.
    echo "$output" | jq -e '.hookSpecificOutput.additionalContext | test("unrecognized host")' >/dev/null
}

@test "permission-denied-coach: retry hint even when the payload carries no reason" {
    payload='{"tool_name":"Bash","tool_input":{"command":"npm install"}}'
    run bash "$CLAUDE_PLUGIN_ROOT/scripts/permission-denied-coach.sh" <<< "$payload"
    _assert_retry_hint
}

@test "permission-denied-coach: pass-through for a non-Bash tool" {
    payload='{"tool_name":"Read","reason":"Blocked by classifier","tool_input":{}}'
    run bash "$CLAUDE_PLUGIN_ROOT/scripts/permission-denied-coach.sh" <<< "$payload"
    [ "$status" -eq 0 ]
    # No retry hint emitted for tools the model cannot usefully rephrase.
    [ -z "$output" ] || ! echo "$output" | jq -e '.hookSpecificOutput.retry == true' >/dev/null
}
