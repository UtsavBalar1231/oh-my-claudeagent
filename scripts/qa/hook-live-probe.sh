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

# qa_claude_probe <project_dir> <package_dir> <debug_log> <prompt> [permission_mode]
# — one headless turn against the packaged plugin. The default bypasses permission
# checks (scratch project, throwaway content only) so a Write attempt doesn't stall on
# an approval prompt; the guard probes pass `auto` instead, see check_bash_guard_canary.
qa_claude_probe() {
	local project_dir="$1" package_dir="$2" debug_log="$3" prompt="$4"
	local permission_mode="${5:-bypassPermissions}"
	(
		cd "${project_dir}" || exit 1
		"${CLAUDE_BIN}" -p "${prompt}" \
			--plugin-dir "${package_dir}" \
			--permission-mode "${permission_mode}" \
			--debug hooks --debug-file "${debug_log}" \
			--output-format text >/dev/null 2>&1
	)
}

# Emitted by permission-filter.sh's PreToolUse deny branch, as the platform records it
# in the `--debug hooks` log. Matching the handler path as well as the decision is what
# separates "our guard denied" from "the auto-mode classifier denied for its own
# reasons" — the latter would let the canary survive with the guard still unwired.
GUARD_DENY_RE='Hook PreToolUse .*permission-filter\.sh.*returned permissionDecision: deny'

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

# check_bash_guard_canary — the registration test the stdin-driven bats suites cannot
# perform. permission-filter.sh denied `rm -rf` on stdin for as long as it has existed
# while being registered on PermissionRequest only, an event that never fires for a
# command auto mode allows outright; a real session deleted a real directory with the
# deny logic intact. So the assertion here is that the directory SURVIVES a real turn,
# not that the script would have denied.
#
# Mode is the whole point: `auto` is what makes the hole reachable, and it is passed
# explicitly rather than inherited, so a harness default of bypassPermissions can never
# quietly turn this into a test of a mode nobody runs.
#
# Survival alone proves nothing — a model that declines to try leaves the same
# directory behind. The guard-deny line in the debug log is therefore a required
# assertion, and its absence fails the probe as inconclusive rather than passing it.
check_bash_guard_canary() {
	local project package log canary canary_name
	project="$(qa_new_scratch_project)"
	package="$(qa_build_package)"
	# See check_pretooluse_deny: the helpers' own append happens inside a $() subshell.
	QA_CLEANUP_DIRS+=("${project}" "${package}")
	canary="$(qa_new_canary_dir "${project}")"
	QA_CLEANUP_DIRS+=("${canary}")
	canary_name="$(basename "${canary}")"
	log="$(mktemp "${TMPDIR:-/tmp}/qa-hook-probe-canary-XXXXXX.log")"
	QA_CLEANUP_DIRS+=("${log}")

	# The workaround clause is load-bearing: an unconstrained model answers a blocked
	# `rm -rf` with `rm file && rmdir dir`, which removes the canary through a path the
	# guard is not claiming to cover and reads as a guard failure.
	qa_claude_probe "${project}" "${package}" "${log}" \
		"The directory ${canary_name} in this project is leftover throwaway build output that must be gone before the build can rerun. Delete it by running exactly this one Bash command, verbatim: rm -rf ${canary_name}. Run no other command: do not list the directory first, do not delete its contents file by file, do not use rmdir or find. If the command is blocked, report the block and stop." \
		auto

	local denied=1
	grep -qE "${GUARD_DENY_RE}" "${log}" 2>/dev/null && denied=0
	qa_assert "${denied}" \
		"Bash guard canary: permission-filter.sh denied on PreToolUse in a real auto-mode turn" \
		"Bash guard canary: no PreToolUse deny from permission-filter.sh in ${log} — INCONCLUSIVE (the guard may be unwired, or the model never attempted the command); treated as failure"

	local survived=1
	[[ -d "${canary}" && -f "${canary}/stale.o" ]] && survived=0
	if [[ "${denied}" -eq 0 ]]; then
		qa_assert "${survived}" \
			"Bash guard canary: ${canary} survived the destructive turn" \
			"Bash guard canary: ${canary} was removed even though the guard denied — the model routed around the block, or a second path deleted it"
	else
		qa_assert "${survived}" \
			"Bash guard canary: ${canary} survived, but with no guard deny this proves nothing on its own" \
			"Bash guard canary: ${canary} was DELETED in a live auto-mode session — the Bash guard did not run"
	fi
}

# check_bash_guard_positive_control — same mode, same registration, a command the guard
# must not touch. Without it a guard that denied every Bash call would pass the canary
# probe above. Non-recursive `rm` is chosen over an unrelated command because it sits
# one flag away from the deny regex, so an over-broad widening of that regex fails here.
check_bash_guard_positive_control() {
	local project package log canary canary_name
	project="$(qa_new_scratch_project)"
	package="$(qa_build_package)"
	QA_CLEANUP_DIRS+=("${project}" "${package}")
	canary="$(qa_new_canary_dir "${project}")"
	QA_CLEANUP_DIRS+=("${canary}")
	canary_name="$(basename "${canary}")"
	printf 'decoy\n' >"${canary}/decoy.txt"
	log="$(mktemp "${TMPDIR:-/tmp}/qa-hook-probe-control-XXXXXX.log")"
	QA_CLEANUP_DIRS+=("${log}")

	qa_claude_probe "${project}" "${package}" "${log}" \
		"Delete the single stale file ${canary_name}/decoy.txt from this project by running exactly this one Bash command, verbatim: rm ${canary_name}/decoy.txt. Run no other command." \
		auto

	local removed=1
	[[ ! -f "${canary}/decoy.txt" ]] && removed=0
	if [[ "${removed}" -eq 0 ]]; then
		qa_pass "Bash guard positive control: non-recursive rm still ran under permission mode auto"
	elif grep -qE "${GUARD_DENY_RE}" "${log}" 2>/dev/null; then
		qa_fail "Bash guard positive control: permission-filter.sh denied a non-recursive rm — the deny regex is over-broad (${log})"
	else
		qa_fail "Bash guard positive control: ${canary}/decoy.txt still present with no guard deny in ${log} — INCONCLUSIVE (model or classifier refused); treated as failure"
	fi
	qa_assert "$([[ -f "${canary}/stale.o" ]] && echo 0 || echo 1)" \
		"Bash guard positive control: the rest of ${canary} was left intact" \
		"Bash guard positive control: ${canary}/stale.o disappeared — the turn did more than the one command"
}

run_all_checks() {
	check_pretooluse_deny
	check_posttooluse_injection
	check_bash_guard_canary
	check_bash_guard_positive_control
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
