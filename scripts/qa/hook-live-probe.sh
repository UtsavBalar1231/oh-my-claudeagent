#!/bin/bash
# scripts/qa/hook-live-probe.sh — ONE live probe per hook family against the PACKAGED
# plugin, driving a real headless `claude -p` turn per the isolation model (real HOME,
# scratch project, --plugin-dir on the packaged tree). This proves registration-to-
# execution in the artifact a user actually installs; it is NOT a re-run of the bats
# suites, which already cover each hook's internal logic against fixtures.
#
# Usage: scripts/qa/hook-live-probe.sh [--self-test]

QA_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/qa-common.sh
source "${QA_DIR}/lib/qa-common.sh"

CLAUDE_BIN="${QA_CLAUDE_BIN:-claude}"

# qa_claude_probe <project_dir> <package_dir> <debug_log> <prompt> — one headless turn
# against the packaged plugin, permission checks bypassed (scratch project, throwaway
# content only) so a Write attempt doesn't stall on an approval prompt.
qa_claude_probe() {
	local project_dir="$1" package_dir="$2" debug_log="$3" prompt="$4"
	(
		cd "${project_dir}" || exit 1
		"${CLAUDE_BIN}" -p "${prompt}" \
			--plugin-dir "${package_dir}" \
			--permission-mode bypassPermissions \
			--debug hooks --debug-file "${debug_log}" \
			--output-format text >/dev/null 2>&1
	)
}

# check_pretooluse_deny — a zero-checkbox plan-shaped Write must be denied by the
# validate_plan_write mcp_tool hook (Write|Edit matcher). Also feeds check_stop_negative
# below: the same turn's Stop event is inspected there so this only costs one API call.
check_pretooluse_deny() {
	local project package log
	project="$(qa_new_scratch_project)"
	package="$(qa_build_package)"
	# qa_new_scratch_project/qa_build_package run in the $() subshells above, so their
	# own QA_CLEANUP_DIRS append never reaches this process; register here instead.
	QA_CLEANUP_DIRS+=("${project}" "${package}")
	log="$(mktemp "${TMPDIR:-/tmp}/qa-hook-probe-deny-XXXXXX.log")"
	QA_CLEANUP_DIRS+=("${log}")

	qa_claude_probe "${project}" "${package}" "${log}" \
		'Use the Write tool to create a file at plans/no-checkboxes.md with exactly this content and nothing else: "## Work Objectives\n\nSome text with no checkboxes."'

	if grep -q 'PLAN-CHECKBOX-VERIFY' "${log}" 2>/dev/null; then
		qa_pass "PreToolUse deny: validate_plan_write fired on the zero-checkbox plan write"
	else
		qa_fail "PreToolUse deny: no PLAN-CHECKBOX-VERIFY denial found in debug log ${log}"
	fi
	if [[ ! -f "${project}/plans/no-checkboxes.md" ]]; then
		qa_pass "PreToolUse deny: denied write did not land on disk"
	else
		qa_fail "PreToolUse deny: file exists despite expected denial: ${project}/plans/no-checkboxes.md"
	fi

	check_stop_negative "${log}" "${project}"
}

# check_stop_negative <debug_log> <project_dir> — no bound plan in this scratch
# project, so all three registered Stop hooks must report a silent, non-blocking
# success. Shares the deny probe's turn rather than spending a second API call.
check_stop_negative() {
	local log="$1" project="$2"
	local stop_hits
	stop_hits=$(grep -c 'Hook Stop (Stop) success' "${log}" 2>/dev/null || true)
	if [[ "${stop_hits:-0}" -ge 3 ]]; then
		qa_pass "Stop negative: all 3 registered Stop hooks completed (${stop_hits} success lines)"
	else
		qa_fail "Stop negative: expected 3 Stop hook completions, saw ${stop_hits:-0} in ${log}"
	fi
	if [[ ! -f "${project}/.omca/state/boulder.json" ]]; then
		qa_pass "Stop negative: no boulder.json bound in the scratch project"
	else
		qa_fail "Stop negative: unexpected boulder.json in scratch project ${project}"
	fi
	if grep -q 'permissionDecision.*deny' "${log}" && grep -A2 'plan-continuation-guard\|final-verification-evidence\|drift-guard' "${log}" | grep -q 'block'; then
		qa_fail "Stop negative: a Stop hook reported block with no bound plan"
	else
		qa_pass "Stop negative: no Stop hook reported a block"
	fi
}

# check_posttooluse_injection — three direct Write calls in one turn, no Agent
# delegation, must trip delegation-reminder.sh's PostToolUse injection.
check_posttooluse_injection() {
	local project package log
	project="$(qa_new_scratch_project)"
	package="$(qa_build_package)"
	# See check_pretooluse_deny: the helpers' own append happens inside a $() subshell
	# and is lost when it exits.
	QA_CLEANUP_DIRS+=("${project}" "${package}")
	log="$(mktemp "${TMPDIR:-/tmp}/qa-hook-probe-reminder-XXXXXX.log")"
	QA_CLEANUP_DIRS+=("${log}")

	qa_claude_probe "${project}" "${package}" "${log}" \
		'Use the Write tool three separate times, once each, to create: a.txt containing "a", then b.txt containing "b", then c.txt containing "c". Do not use any other tool.'

	if grep -q 'DELEGATION REMINDER' "${log}" 2>/dev/null; then
		qa_pass "PostToolUse injection: delegation-reminder fired after 3 direct Write calls"
	else
		qa_fail "PostToolUse injection: no DELEGATION REMINDER text found in debug log ${log}"
	fi
}

run_all_checks() {
	check_pretooluse_deny
	check_posttooluse_injection
}

if [[ "${1:-}" == "--self-test" ]]; then
	trap qa_teardown EXIT
	qa_drift_capture
	echo "[hook-live-probe --self-test] runs the same live probes; this IS the guard"
	run_all_checks
	qa_log "hook-live-probe self-test: ${QA_PASS_COUNT} passed, ${QA_FAIL_COUNT} failed"
	[[ "${QA_FAIL_COUNT}" -eq 0 ]]
	exit $?
fi

trap qa_teardown EXIT
qa_drift_capture
run_all_checks
qa_log "hook-live-probe: ${QA_PASS_COUNT} passed, ${QA_FAIL_COUNT} failed"
[[ "${QA_FAIL_COUNT}" -eq 0 ]]
