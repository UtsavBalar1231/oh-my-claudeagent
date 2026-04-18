#!/usr/bin/env bats
# Regression guard for sisyphus orchestration contract and Plan Execution Mode.
# Replaces tests/bats/hooks/atlas_anti_rationalization_canary.bats (deleted in v2.0
# when the atlas agent was merged into sisyphus + commands/start-work.md).

load '../test_helper'

@test "sisyphus canary: Plan Execution Mode section present in sisyphus.md" {
	grep -qF "## Plan Execution Mode" "${CLAUDE_PLUGIN_ROOT}/agents/sisyphus.md"
}

@test "sisyphus canary: hard-refuse policy present in sisyphus.md" {
	grep -qF "MUST REFUSE" "${CLAUDE_PLUGIN_ROOT}/agents/sisyphus.md" || grep -qiF "no degraded mode" "${CLAUDE_PLUGIN_ROOT}/agents/sisyphus.md"
}

@test "sisyphus canary: commands/start-work.md carries 6-Section Prompt Structure" {
	grep -qF "## 6-Section Prompt Structure" "${CLAUDE_PLUGIN_ROOT}/commands/start-work.md"
}

@test "sisyphus canary: commands/start-work.md carries Final Verification Wave section" {
	grep -qF "## Final Verification Wave" "${CLAUDE_PLUGIN_ROOT}/commands/start-work.md"
}

@test "sisyphus canary: commands/start-work.md carries FROZEN Plan Discipline" {
	grep -qF "## FROZEN Plan Discipline" "${CLAUDE_PLUGIN_ROOT}/commands/start-work.md"
}

@test "sisyphus canary: F1-F4 evidence_type strings preserved in commands/start-work.md" {
	grep -qF "final_verification_f1" "${CLAUDE_PLUGIN_ROOT}/commands/start-work.md"
	grep -qF "final_verification_f2" "${CLAUDE_PLUGIN_ROOT}/commands/start-work.md"
	grep -qF "final_verification_f3" "${CLAUDE_PLUGIN_ROOT}/commands/start-work.md"
	grep -qF "final_verification_f4" "${CLAUDE_PLUGIN_ROOT}/commands/start-work.md"
}
