#!/usr/bin/env bats
# Regression guard for the F1-F4 anti-rationalization clauses and FROZEN plan discipline
# added per the orchestration-discipline-fix plan. Prevents silent prose drift on future
# agents/atlas.md edits. Same canary pattern as templates/claudemd.md:19.

load '../test_helper'

@test "atlas canary: contains anti-rationalization clause 'Direct file inspection is NOT a substitute'" {
	grep -qF "Direct file inspection is NOT a substitute" "${CLAUDE_PLUGIN_ROOT}/agents/atlas.md"
}

@test "atlas canary: contains anti-rationalization clause 'wouldn't change the outcome'" {
	grep -qF "wouldn't change the outcome" "${CLAUDE_PLUGIN_ROOT}/agents/atlas.md"
}

@test "atlas canary: contains hard-refuse policy 'MUST REFUSE' for depth >= 1" {
	grep -qF "MUST REFUSE" "${CLAUDE_PLUGIN_ROOT}/agents/atlas.md"
}

@test "atlas canary: contains 'no degraded mode' policy statement" {
	grep -qiF "no degraded mode" "${CLAUDE_PLUGIN_ROOT}/agents/atlas.md"
}

@test "atlas canary: contains FROZEN plan discipline marker" {
	grep -qF "FROZEN" "${CLAUDE_PLUGIN_ROOT}/agents/atlas.md"
}

@test "atlas canary: contains pending-final-verify.json freeze discipline" {
	grep -qF "pending-final-verify.json" "${CLAUDE_PLUGIN_ROOT}/agents/atlas.md"
}

@test "atlas canary: contains session_id field in freeze discipline" {
	grep -qF "session_id" "${CLAUDE_PLUGIN_ROOT}/agents/atlas.md"
}
