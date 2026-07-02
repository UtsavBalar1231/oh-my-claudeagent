#!/bin/bash
# scripts/qa/statusline-probe.sh — pipe a fixture payload with effort/thinking fields
# into the statusline direct-mode entry point and assert the markers render. No
# session, no `claude` invocation, no drift risk: a throwaway HOME is fine here.
#
# Usage: scripts/qa/statusline-probe.sh [--self-test]

QA_DIR="$(cd "$(dirname "$0")" && pwd)"
QA_ROOT="$(cd "${QA_DIR}/../.." && pwd)"
# shellcheck source=lib/qa-common.sh
source "${QA_DIR}/lib/qa-common.sh"

# No `claude` session is driven here, so this probe needs none of the drift-watch
# machinery the other scripts use. The real HOME is left as-is: `uv run --project`
# resolves its cache/venv relative to HOME, and a throwaway HOME breaks that
# resolution without buying any isolation this probe actually needs.
#
# `python -m statusline.direct` with cwd=repo root, not the installed `cc-statusline-
# direct` console script: the statusline/pyproject.toml wheel target ships an empty
# package (packages = ["statusline"] expects a nested statusline/statusline/ dir that
# doesn't exist — the actual modules sit flat beside pyproject.toml), so the installed
# console script raises ModuleNotFoundError. `-m` from repo root uses the same
# sys.path insertion pytest already relies on for statusline/tests/, so it works
# without touching that pre-existing packaging gap (out of scope for this task).

# CLAUDE_STATUSLINE_NERD_FONT=0 forces ASCII glyphs, so the assertions below match a
# literal marker rather than a nerd-font glyph the runtime terminal may or may not
# render.
check_effort_and_thinking_markers() {
	local payload output
	payload='{"model":{"display_name":"claude-3-5-sonnet"},"context_window":{"context_window_size":200000,"used_percentage":10.0},"cost":{},"effort":{"level":"high"},"thinking":{"enabled":true}}'
	output=$(printf '%s' "${payload}" | (cd "${QA_ROOT}" && CLAUDE_STATUSLINE_NERD_FONT=0 uv run --project statusline python -m statusline.direct))

	if [[ "${output}" == *"E: high"* ]]; then
		qa_pass "effort marker rendered (E: high)"
	else
		qa_fail "effort marker missing from output: ${output}"
	fi
	if [[ "${output}" == *"[T]"* ]]; then
		qa_pass "thinking marker rendered ([T])"
	else
		qa_fail "thinking marker missing from output: ${output}"
	fi
}

check_defaults_absent() {
	local payload output
	payload='{"model":{"display_name":"claude-3-5-sonnet"},"context_window":{"context_window_size":200000,"used_percentage":10.0},"cost":{}}'
	output=$(printf '%s' "${payload}" | (cd "${QA_ROOT}" && CLAUDE_STATUSLINE_NERD_FONT=0 uv run --project statusline python -m statusline.direct))

	if [[ "${output}" != *"E:"* && "${output}" != *"[T]"* ]]; then
		qa_pass "no effort/thinking markers rendered when fields are absent"
	else
		qa_fail "effort/thinking markers rendered without input fields: ${output}"
	fi
}

run_all_checks() {
	check_effort_and_thinking_markers
	check_defaults_absent
}

if [[ "${1:-}" == "--self-test" ]]; then
	echo "[statusline-probe --self-test]"
	run_all_checks
	qa_log "statusline-probe self-test: ${QA_PASS_COUNT} passed, ${QA_FAIL_COUNT} failed"
	[[ "${QA_FAIL_COUNT}" -eq 0 ]]
	exit $?
fi

run_all_checks
qa_log "statusline-probe: ${QA_PASS_COUNT} passed, ${QA_FAIL_COUNT} failed"
[[ "${QA_FAIL_COUNT}" -eq 0 ]]
