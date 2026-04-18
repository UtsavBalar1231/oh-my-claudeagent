#!/usr/bin/env bats
# Unit tests for structural constraints in agents/prometheus.md

load '../test_helper'

@test "prometheus template has no Final Checklist mandate" {
	local count
	count=$(grep -c '^### Final Checklist' "$CLAUDE_PLUGIN_ROOT/agents/prometheus.md" 2>/dev/null || true)
	count="${count:-0}"
	[ "$count" -eq 0 ]
}

@test "prometheus template has Completion Signaling subsection" {
	local count
	count=$(grep -c '^### Completion Signaling' "$CLAUDE_PLUGIN_ROOT/agents/prometheus.md" 2>/dev/null || true)
	count="${count:-0}"
	[ "$count" -eq 1 ]
}
