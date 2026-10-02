#!/bin/bash
# scripts/qa/mock-model-e2e.sh — drives a real headless `claude -p` through the scripted
# mock (scripts/qa/mock-model.ts) and checks the tool-use loop end to end.
#
# No real API call can happen here: ANTHROPIC_BASE_URL points at 127.0.0.1, the key is a
# dummy so a client that ignored the base URL would be rejected, and every logged request
# must come from localhost. --safe-mode keeps the installed plugins' hooks out of the run.
#
# Usage: scripts/qa/mock-model-e2e.sh

QA_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/qa-common.sh
source "${QA_DIR}/lib/qa-common.sh"

CLAUDE_BIN="${QA_CLAUDE_BIN:-claude}"
MOCK_MODEL_TS="${QA_DIR}/mock-model.ts"

MOCK_PID=""
MOCK_PORT=""

# start_mock <script_json> <access_log> — sets MOCK_PID and MOCK_PORT from the mock's
# readiness line (the bound port on its first stdout line).
start_mock() {
	local script="$1" access_log="$2" port_file waited=0
	port_file="$(mktemp "${TMPDIR:-/tmp}/qa-mock-port-XXXXXX")"
	QA_CLEANUP_DIRS+=("${port_file}")
	bun "${MOCK_MODEL_TS}" --port 0 --script "${script}" --access-log "${access_log}" >"${port_file}" &
	MOCK_PID=$!
	while [[ ! -s "${port_file}" ]]; do
		sleep 0.1
		waited=$((waited + 1))
		if [[ "${waited}" -gt 50 ]]; then
			qa_fail "mock-model.ts did not print its port within 5s"
			return 1
		fi
	done
	MOCK_PORT="$(head -n 1 "${port_file}")"
}

# stop_mock — keeps the caller's $?, so it can sit in front of qa_teardown in the EXIT trap.
stop_mock() {
	local status=$?
	if [[ -n "${MOCK_PID}" ]]; then
		kill "${MOCK_PID}" 2>/dev/null || true
		wait "${MOCK_PID}" 2>/dev/null || true
		MOCK_PID=""
	fi
	return "${status}"
}

# run_claude <project> <prompt> — prints the turn's stdout.
run_claude() {
	local project="$1" prompt="$2"
	(
		cd "${project}" && env DISABLE_AUTOUPDATER=1 ANTHROPIC_API_KEY=mock-key \
			ANTHROPIC_BASE_URL="http://127.0.0.1:${MOCK_PORT}" \
			"${CLAUDE_BIN}" -p "${prompt}" --safe-mode \
			--permission-mode bypassPermissions --output-format text 2>&1 </dev/null
	)
}

# assert_localhost_only <access_log> — every logged request came from 127.0.0.1, and at
# least one was logged, so the client demonstrably reached the mock rather than the net.
assert_localhost_only() {
	local log="$1" total foreign
	total="$(jq -s 'length' "${log}")"
	foreign="$(jq -s '[.[] | select(.client != "127.0.0.1")] | length' "${log}")"
	if [[ "${total}" -ge 1 && "${foreign}" -eq 0 ]]; then
		qa_pass "all ${total} logged requests came from 127.0.0.1"
	else
		qa_fail "expected >= 1 localhost-only request, got total=${total} foreign=${foreign}"
	fi
}

# assert_jq_equals <log> <jq filter> <expected> <message> — compares a compact jq result.
assert_jq_equals() {
	local log="$1" filter="$2" expected="$3" message="$4" actual
	actual="$(jq -sc "${filter}" "${log}")"
	if [[ "${actual}" == "${expected}" ]]; then
		qa_pass "${message}: ${actual}"
	else
		qa_fail "${message}: expected ${expected}, got ${actual}"
	fi
}

bash_chain_scenario() {
	local project script log output
	project="$(qa_new_scratch_project)"
	QA_CLEANUP_DIRS+=("${project}")
	script="${project}/bash-chain.json"
	log="${project}/bash-chain.log"
	jq -n '{main: ([range(3)] | map({content: [{type: "tool_use", name: "Bash", input: {command: "true", description: "no-op"}}]})) + [{content: [{type: "text", text: "chain finished"}]}]}' >"${script}"

	start_mock "${script}" "${log}" || return
	output="$(run_claude "${project}" 'run the chain')"
	stop_mock

	if [[ "${output}" == "chain finished" ]]; then
		qa_pass "bash chain: final scripted text reached stdout"
	else
		qa_fail "bash chain: unexpected stdout: ${output}"
	fi
	assert_jq_equals "${log}" '[.[] | select(.queue == "main") | .tool_results]' '[0,1,2,3]' "bash chain: tool_results per main request"
	assert_jq_equals "${log}" '[.[] | select(.queue == "main") | .turn]' '[0,1,2,3]' "bash chain: served turn per main request"
	assert_localhost_only "${log}"
}

agent_scenario() {
	local project script log output
	project="$(qa_new_scratch_project)"
	QA_CLEANUP_DIRS+=("${project}")
	script="${project}/agent.json"
	log="${project}/agent.log"
	# The Agent tool launches asynchronously under `claude -p`: the main thread answers the
	# launch result (turn 1), then gets one more request when the subagent finishes (turn 2).
	jq -n '{main: [{content: [{type: "tool_use", name: "Agent", input: {description: "probe", prompt: "say hi", subagent_type: "general-purpose"}}]}, {content: [{type: "text", text: "agent launched"}]}, {content: [{type: "text", text: "agent finished"}]}], subagent: [{content: [{type: "text", text: "hi from the subagent"}]}]}' >"${script}"

	start_mock "${script}" "${log}" || return
	output="$(run_claude "${project}" 'run the probe')"
	stop_mock

	if [[ "${output}" == "agent finished" ]]; then
		qa_pass "agent: final scripted text reached stdout"
	else
		qa_fail "agent: unexpected stdout: ${output}"
	fi
	assert_jq_equals "${log}" '[.[] | select(.queue == "main") | .turn]' '[0,1,2]' "agent: served turn per main request"
	assert_jq_equals "${log}" '[.[] | select(.queue == "subagent")] | length' '1' "agent: requests routed to the subagent queue"
	assert_jq_equals "${log}" '[.[] | select(.queue == "subagent") | .turn]' '[0]' "agent: subagent served its scripted turn"
	assert_localhost_only "${log}"
}

trap 'stop_mock; qa_teardown' EXIT
qa_drift_capture

bash_chain_scenario
agent_scenario

qa_log "mock-model-e2e: ${QA_PASS_COUNT} passed, ${QA_FAIL_COUNT} failed"
[[ "${QA_FAIL_COUNT}" -eq 0 ]]
