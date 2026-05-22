#!/usr/bin/env bats
# Regression tests: CL4R1T4S role-grounding principle — assert absence of persona inflation strings.
# Principle: production agent prompts define role via concrete capabilities and constraints,
# not unverifiable quality claims or behavioral adjectives.

load '../test_helper'

@test "no agent contains 'indistinguishable from'" {
	local count
	count=$(grep -rl "indistinguishable from" "$CLAUDE_PLUGIN_ROOT/agents/" 2>/dev/null | wc -l || true)
	count="${count:-0}"
	[ "$count" -eq 0 ]
}

@test "no agent contains 'SF Bay Area'" {
	local count
	count=$(grep -rl "SF Bay Area" "$CLAUDE_PLUGIN_ROOT/agents/" 2>/dev/null | wc -l || true)
	count="${count:-0}"
	[ "$count" -eq 0 ]
}

@test "no agent contains 'obsessively'" {
	local count
	count=$(grep -rl "obsessively" "$CLAUDE_PLUGIN_ROOT/agents/" 2>/dev/null | wc -l || true)
	count="${count:-0}"
	[ "$count" -eq 0 ]
}
