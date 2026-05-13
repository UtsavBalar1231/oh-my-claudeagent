#!/usr/bin/env bats
load "../test_helper"

@test "permission-denied-coach: retry hint for Bash allowlist deny" {
    payload='{"tool_name":"Bash","reason":"not in allowlist","tool_input":{"command":"npm install"}}'
    run bash "$CLAUDE_PLUGIN_ROOT/scripts/permission-denied-coach.sh" <<< "$payload"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.retry == true' >/dev/null
    echo "$output" | jq -e '.hookSpecificOutput.hookEventName == "PermissionDenied"' >/dev/null
}

@test "permission-denied-coach: pass-through for unknown denial" {
    payload='{"tool_name":"Read","reason":"sandbox","tool_input":{}}'
    run bash "$CLAUDE_PLUGIN_ROOT/scripts/permission-denied-coach.sh" <<< "$payload"
    [ "$status" -eq 0 ]
    # No retry hint emitted for unknown denial reasons
    [ -z "$output" ] || ! echo "$output" | jq -e '.retry == true' >/dev/null
}
