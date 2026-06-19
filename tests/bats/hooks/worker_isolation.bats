#!/usr/bin/env bats
# Regression guard for the subagent "stub final message" bug: orchestrator-only barrier
# imperatives leaking into worker-visible surfaces made workers emit "Done."/"Waiting."/"✓"
# stubs instead of their deliverable. Locks in: no bare barrier imperative in any
# worker-visible surface, and every worker def carries an explicit leaf-worker contract.

load '../test_helper'

# Surfaces a spawned worker subagent can see: its own definition, the globally-applied
# output style (force-for-plugin: true), and the CLAUDE.md block injected by omca-setup.
# All leaf-worker definitions — the negative (no-barrier-imperative) check covers every one.
WORKER_AGENT_DEFS=(
	"agents/executor.md"
	"agents/explore.md"
	"agents/librarian.md"
	"agents/multimodal-looker.md"
	"agents/oracle.md"
	"agents/momus.md"
	"agents/hephaestus.md"
)

# Heavy-read workers that empirically stubbed under context pressure — these must carry an
# explicit inline anti-stub contract (defense-in-depth if the SubagentStart hook misfires).
WORKER_DEFS_NEED_CONTRACT=(
	"agents/executor.md"
	"agents/explore.md"
	"agents/librarian.md"
	"agents/multimodal-looker.md"
)

GLOBAL_WORKER_VISIBLE=(
	"output-styles/omca-default.md"
	"skills/omca-setup/orchestration-block.md"
)

@test "worker isolation: no bare barrier imperative in worker-visible surfaces" {
	# These exact imperatives are the bug. They belong only in the orchestrator's own
	# definition (agents/sisyphus.md) and command bodies, which workers never load.
	local pattern='end response, wait|END the response while|Waiting for N more'
	local f
	for f in "${WORKER_AGENT_DEFS[@]}" "${GLOBAL_WORKER_VISIBLE[@]}"; do
		run grep -niE "${pattern}" "${CLAUDE_PLUGIN_ROOT}/${f}"
		[ "${status}" -ne 0 ] || {
			echo "FAIL: barrier imperative found in worker-visible surface ${f}:"
			echo "${output}"
			false
		}
	done
}

@test "worker isolation: removed barrier section absent from executor.md" {
	run grep -qF "## Background Agent Results" "${CLAUDE_PLUGIN_ROOT}/agents/executor.md"
	[ "${status}" -ne 0 ]
}

@test "worker isolation: every worker agent def carries a leaf-worker / anti-stub contract" {
	local f
	for f in "${WORKER_DEFS_NEED_CONTRACT[@]}"; do
		run grep -iE "leaf worker|bare status word|never a valid final message" "${CLAUDE_PLUGIN_ROOT}/${f}"
		[ "${status}" -eq 0 ] || {
			echo "FAIL: ${f} lacks an explicit leaf-worker / anti-stub contract"
			false
		}
	done
}

@test "worker isolation: SubagentStart hook still injects the NEVER STUB reinforcement" {
	grep -qF "[NEVER STUB]" "${CLAUDE_PLUGIN_ROOT}/scripts/subagent-start.sh"
	grep -qF "[YOU ARE A LEAF WORKER]" "${CLAUDE_PLUGIN_ROOT}/scripts/subagent-start.sh"
}
