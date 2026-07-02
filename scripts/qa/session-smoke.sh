#!/bin/bash
# scripts/qa/session-smoke.sh — end-to-end packaged-plugin session smoke test.
# SKIP-BY-DEFAULT: session-smoke is the one script in the harness that costs real
# inference (mock or real API), so unlike the other four it does not run unconditionally.
#
# Backend selection:
#   1. scripts/qa/mock-model.py exists and QA_FORCE_REAL_API != 1 -> mock-backed,
#      runs by default (deterministic, no real API spend, no subscription-auth
#      dependency). This is the default path now that mock-model.py exists.
#   2. QA_ALLOW_REAL_API=1 (or QA_FORCE_REAL_API=1) -> one real-API headless turn.
#   3. Neither, and no mock present -> SKIPPED banner, exit 0. This is a PASS.
#
# Usage: scripts/qa/session-smoke.sh [--self-test]

QA_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/qa-common.sh
source "${QA_DIR}/lib/qa-common.sh"

CLAUDE_BIN="${QA_CLAUDE_BIN:-claude}"
MOCK_MODEL_PY="${QA_DIR}/mock-model.py"

# Known OMCA agent basenames (agents/*.md in this repo), used to assert the session
# surface actually reflects the packaged agent catalog rather than a generic response.
KNOWN_AGENTS=(executor explore hephaestus librarian oracle prometheus sisyphus metis momus)

# assert_agent_names_present <text> — at least 2 known agent names must appear;
# requiring more than 1 avoids a false pass on an incidental single-word match.
assert_agent_names_present() {
	local text="$1" hits=0 name
	for name in "${KNOWN_AGENTS[@]}"; do
		[[ "${text}" == *"${name}"* ]] && hits=$((hits + 1))
	done
	if [[ "${hits}" -ge 2 ]]; then
		qa_pass "session surface shows ${hits} known OMCA agent names"
	else
		qa_fail "session surface shows only ${hits} known OMCA agent name(s), expected >= 2"
	fi
}

# assert_state_dir_created <project_dir> — any hook firing (SessionStart, UserPromptSubmit,
# tool events) mkdir -p's HOOK_STATE_DIR, so its presence is proof the packaged hooks
# actually ran in this session, not just that the CLI printed a static response.
assert_state_dir_created() {
	local project_dir="$1"
	if [[ -d "${project_dir}/.omca/state" ]]; then
		qa_pass ".omca/state/ was created in the scratch project"
	else
		qa_fail ".omca/state/ was not created in the scratch project"
	fi
}

# assert_access_log_localhost_only <log_path> — proves the mock actually served the
# inference hit (>=1 JSONL entry for /v1/messages) and that every entry's client
# address is 127.0.0.1, i.e. nothing left localhost during the mock-backed turn.
assert_access_log_localhost_only() {
	local log_path="$1"
	if [[ ! -s "${log_path}" ]]; then
		qa_fail "mock access log ${log_path} is missing or empty, expected >= 1 inference hit"
		return
	fi
	local hits non_localhost
	hits=$(grep -c '"path": "/v1/messages' "${log_path}" || true)
	non_localhost=$(grep -vc '"client": "127.0.0.1"' "${log_path}" || true)
	if [[ "${hits}" -ge 1 && "${non_localhost}" -eq 0 ]]; then
		qa_pass "mock access log shows ${hits} localhost-only /v1/messages hit(s)"
	else
		qa_fail "mock access log check failed: hits=${hits} non_localhost_entries=${non_localhost}"
	fi
}

run_real_api_smoke() {
	local project package output
	project="$(qa_new_scratch_project)"
	# qa_new_scratch_project/qa_build_package run in the $() subshell above, so their
	# own QA_CLEANUP_DIRS append never reaches this process; register here instead.
	QA_CLEANUP_DIRS+=("${project}")
	package="$(qa_build_package)"
	QA_CLEANUP_DIRS+=("${package}")

	output=$(
		cd "${project}" && "${CLAUDE_BIN}" -p \
			'Call the agents_list tool from the omca MCP server and print only the returned agent names, one per line, no other commentary.' \
			--plugin-dir "${package}" \
			--permission-mode bypassPermissions \
			--output-format text 2>&1
	)

	assert_agent_names_present "${output}"
	assert_state_dir_created "${project}"
}

# run_mock_backed_smoke <mock_py> — contract mock-model.py satisfies:
# `python3 <mock_py> --port <N> --access-log <path>` starts an HTTP listener on
# 127.0.0.1:<N> shaped like the Messages API (per .omca/notes/mock-model-verdict.md's
# SUPPORTED env contract: requests hit <base>/v1/messages, real Authorization headers
# pass through), logs each request as JSONL, and exits cleanly on SIGTERM.
# ANTHROPIC_BASE_URL is scoped to the claude subprocess only.
run_mock_backed_smoke() {
	local mock_py="$1"
	local port project package output mock_pid access_log
	port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
	project="$(qa_new_scratch_project)"
	# See run_real_api_smoke: register here since the helpers' own append happens
	# inside a $() subshell and is lost when it exits.
	QA_CLEANUP_DIRS+=("${project}")
	package="$(qa_build_package)"
	QA_CLEANUP_DIRS+=("${package}")
	access_log="${project}/.qa-mock-access.log"

	python3 "${mock_py}" --port "${port}" --access-log "${access_log}" &
	mock_pid=$!
	local waited=0
	while ! (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; do
		sleep 0.2
		waited=$((waited + 1))
		if [[ "${waited}" -gt 25 ]]; then
			qa_fail "mock-model.py did not start listening on 127.0.0.1:${port} within 5s"
			kill "${mock_pid}" 2>/dev/null || true
			return
		fi
	done
	exec 3>&- 2>/dev/null || true

	output=$(
		cd "${project}" && env ANTHROPIC_BASE_URL="http://127.0.0.1:${port}" "${CLAUDE_BIN}" -p \
			'reply with the single word ok' \
			--plugin-dir "${package}" \
			--permission-mode bypassPermissions \
			--output-format text 2>&1
	)
	kill "${mock_pid}" 2>/dev/null || true
	wait "${mock_pid}" 2>/dev/null || true

	# The mock scripts a fixed tool-free "ok" turn (no live model reasoning), so the
	# mock-backed assertion is exact-match determinism, not the tool-calling check
	# real-API smoke uses.
	if [[ "${output}" == "ok" ]]; then
		qa_pass "mock-backed turn returned the deterministic scripted text"
	else
		qa_fail "mock-backed turn returned unexpected output: ${output}"
	fi
	assert_state_dir_created "${project}"
	assert_access_log_localhost_only "${access_log}"
}

if [[ "${1:-}" == "--self-test" ]]; then
	echo "[session-smoke --self-test] SKIP path (no mock, QA_ALLOW_REAL_API unset)"
	out=$(QA_ALLOW_REAL_API="" QA_FORCE_REAL_API="" bash "${QA_DIR}/session-smoke.sh")
	status=$?
	if [[ "${out}" == *SKIPPED* && "${status}" -eq 0 ]]; then
		qa_pass "skip-by-default path exits 0 with a SKIPPED banner"
	else
		qa_fail "skip-by-default path did not behave as expected (exit=${status}): ${out}"
	fi
	qa_log "session-smoke self-test: ${QA_PASS_COUNT} passed, ${QA_FAIL_COUNT} failed"
	[[ "${QA_FAIL_COUNT}" -eq 0 ]]
	exit $?
fi

trap qa_teardown EXIT
qa_drift_capture

if [[ -f "${MOCK_MODEL_PY}" && "${QA_FORCE_REAL_API:-}" != "1" ]]; then
	qa_log "mock-model.py present: running mock-backed smoke"
	run_mock_backed_smoke "${MOCK_MODEL_PY}"
elif [[ "${QA_ALLOW_REAL_API:-}" == "1" ]]; then
	qa_log "QA_ALLOW_REAL_API=1: running real-API smoke"
	run_real_api_smoke
else
	qa_log "SKIPPED: scripts/qa/mock-model.py is missing and QA_ALLOW_REAL_API is not 1. Set QA_ALLOW_REAL_API=1 to run a real-API turn, or restore mock-model.py for a deterministic default."
	exit 0
fi

qa_log "session-smoke: ${QA_PASS_COUNT} passed, ${QA_FAIL_COUNT} failed"
[[ "${QA_FAIL_COUNT}" -eq 0 ]]
