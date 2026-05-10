#!/usr/bin/env bats
# golden.bats — per-fixture replay tests for the golden-output harness.
# Each test re-runs a hook via env -i (same isolation as capture-baseline.sh),
# normalizes output, and asserts byte-equivalence against the checked-in baseline.
#
# Baselines live in: tests/bats/hooks/golden/baseline/<hook>/<variant>/
# Fixtures live in:  tests/bats/hooks/golden/fixtures/<hook>/<variant>/

load '../test_helper'

_normalize_stream() {
	local hook_name="$1"
	local golden_dir="$2"
	local custom="${golden_dir}/normalizers/${hook_name}.sh"
	if [[ -x "${custom}" ]]; then
		bash "${golden_dir}/normalize.sh" | bash "${custom}"
	else
		bash "${golden_dir}/normalize.sh"
	fi
}

_run_fixture() {
	local hook_name="$1"
	local variant="$2"
	local golden_dir="${BATS_TEST_DIRNAME}/golden"
	local fixture_dir="${golden_dir}/fixtures/${hook_name}/${variant}"
	local input_json="${fixture_dir}/input.json"
	local hook_path="${CLAUDE_PLUGIN_ROOT}/scripts/${hook_name}.sh"

	# Prepare hermetic work dir
	local work_dir="${BATS_TEST_TMPDIR}/${hook_name}-${variant}"
	mkdir -p "${work_dir}/.omca/state" "${work_dir}/.omca/logs"

	# Extract seed-state if present
	local seed="${fixture_dir}/seed-state.tar"
	if [[ -f "${seed}" ]]; then
		(cd "${work_dir}" && tar xf "${seed}" 2>/dev/null)
	fi

	local before_dir="${work_dir}/state-before"
	cp -r "${work_dir}/.omca/state" "${before_dir}" 2>/dev/null || mkdir -p "${before_dir}"

	local sid
	sid=$(jq -r '.session_id // "fixture-sid-fallback"' "${input_json}" 2>/dev/null)
	local hook_input
	hook_input=$(cat "${input_json}")

	local cli_mode
	cli_mode=$(jq -r '._cli_mode // false' "${input_json}" 2>/dev/null)

	local _hook_exit=0
	if [[ "${cli_mode}" == "true" ]]; then
		local extra_args
		extra_args=$(jq -r '.args | if type == "array" then .[] else empty end' "${input_json}" 2>/dev/null | tr '\n' ' ')
		# shellcheck disable=SC2086
		env -i \
			PATH="${PATH}" \
			HOME="${HOME}" \
			CLAUDE_PROJECT_ROOT="${work_dir}" \
			HOOK_PROJECT_ROOT="${work_dir}" \
			HOOK_STATE_DIR="${work_dir}/.omca/state" \
			HOOK_LOG_DIR="${work_dir}/.omca/logs" \
			bash "${hook_path}" ${extra_args} \
			>"${work_dir}/stdout.raw" 2>"${work_dir}/stderr.raw" || _hook_exit=$?
	else
		env -i \
			PATH="${PATH}" \
			HOME="${HOME}" \
			CLAUDE_SESSION_ID="${sid}" \
			HOOK_INPUT="${hook_input}" \
			CLAUDE_PROJECT_ROOT="${work_dir}" \
			HOOK_PROJECT_ROOT="${work_dir}" \
			HOOK_STATE_DIR="${work_dir}/.omca/state" \
			HOOK_LOG_DIR="${work_dir}/.omca/logs" \
			bash "${hook_path}" <<< "${hook_input}" \
			>"${work_dir}/stdout.raw" 2>"${work_dir}/stderr.raw" || _hook_exit=$?
	fi
	printf '%d\n' "${_hook_exit}" > "${work_dir}/exit_code.txt"

	local after_dir="${work_dir}/state-after"
	cp -r "${work_dir}/.omca/state" "${after_dir}" 2>/dev/null || mkdir -p "${after_dir}"
	diff -ru "${before_dir}" "${after_dir}" 2>/dev/null \
		| sed "s|${work_dir}||g" \
		> "${work_dir}/state-diff.raw" || true

	_normalize_stream "${hook_name}" "${golden_dir}" < "${work_dir}/stdout.raw"     > "${work_dir}/stdout.norm"
	_normalize_stream "${hook_name}" "${golden_dir}" < "${work_dir}/stderr.raw"     > "${work_dir}/stderr.norm"
	_normalize_stream "${hook_name}" "${golden_dir}" < "${work_dir}/state-diff.raw" > "${work_dir}/state-diff.norm"

	local baseline="${golden_dir}/baseline/${hook_name}/${variant}"
	diff "${baseline}/stdout.txt"     "${work_dir}/stdout.norm"
	diff "${baseline}/stderr.txt"     "${work_dir}/stderr.norm"
	diff "${baseline}/exit_code.txt"  "${work_dir}/exit_code.txt"
	diff "${baseline}/state-diff.txt" "${work_dir}/state-diff.norm"
}

@test "golden: agent-usage-reminder/grep-no-agents" {
	_run_fixture "agent-usage-reminder" "grep-no-agents"
}

@test "golden: agent-usage-reminder/agents-already-used" {
	_run_fixture "agent-usage-reminder" "agents-already-used"
}

@test "golden: bash-error-recovery/command-not-found" {
	_run_fixture "bash-error-recovery" "command-not-found"
}

@test "golden: bash-error-recovery/permission-denied" {
	_run_fixture "bash-error-recovery" "permission-denied"
}

@test "golden: bash-error-recovery/test-failure" {
	_run_fixture "bash-error-recovery" "test-failure"
}

@test "golden: comment-checker/ai-attribution" {
	_run_fixture "comment-checker" "ai-attribution"
}

@test "golden: comment-checker/clean-code" {
	_run_fixture "comment-checker" "clean-code"
}

@test "golden: config-change-audit/happy-path" {
	_run_fixture "config-change-audit" "happy-path"
}

@test "golden: context-injector/read-no-agents" {
	_run_fixture "context-injector" "read-no-agents"
}

@test "golden: context-injector/write-no-agents" {
	_run_fixture "context-injector" "write-no-agents"
}

@test "golden: context-injector/edit-no-agents" {
	_run_fixture "context-injector" "edit-no-agents"
}

@test "golden: delegate-retry/nesting-limit" {
	_run_fixture "delegate-retry" "nesting-limit"
}

@test "golden: delegate-retry/rate-limit" {
	_run_fixture "delegate-retry" "rate-limit"
}

@test "golden: edit-error-recovery/not-found" {
	_run_fixture "edit-error-recovery" "not-found"
}

@test "golden: edit-error-recovery/transient" {
	_run_fixture "edit-error-recovery" "transient"
}

@test "golden: empty-task-response/poor-response" {
	_run_fixture "empty-task-response" "poor-response"
}

@test "golden: empty-task-response/good-response" {
	_run_fixture "empty-task-response" "good-response"
}

@test "golden: final-verification-evidence/no-active-plan" {
	_run_fixture "final-verification-evidence" "no-active-plan"
}

@test "golden: final-verification-evidence/recursion-guard" {
	_run_fixture "final-verification-evidence" "recursion-guard"
}

@test "golden: instructions-loaded-audit/happy-path" {
	_run_fixture "instructions-loaded-audit" "happy-path"
}

@test "golden: json-error-recovery/ast-grep-not-found" {
	_run_fixture "json-error-recovery" "ast-grep-not-found"
}

@test "golden: json-error-recovery/mcp-timeout" {
	_run_fixture "json-error-recovery" "mcp-timeout"
}

@test "golden: keyword-detector/no-keyword" {
	_run_fixture "keyword-detector" "no-keyword"
}

@test "golden: keyword-detector/ralph-keyword" {
	_run_fixture "keyword-detector" "ralph-keyword"
}

@test "golden: keyword-detector/ultrawork-keyword" {
	_run_fixture "keyword-detector" "ultrawork-keyword"
}

@test "golden: keyword-detector/stop-continuation" {
	_run_fixture "keyword-detector" "stop-continuation"
}

@test "golden: keyword-detector/cancel" {
	_run_fixture "keyword-detector" "cancel"
}

@test "golden: lifecycle-state/worktree-create" {
	_run_fixture "lifecycle-state" "worktree-create"
}

@test "golden: lifecycle-state/worktree-remove" {
	_run_fixture "lifecycle-state" "worktree-remove"
}

@test "golden: lifecycle-state/cwd-changed" {
	_run_fixture "lifecycle-state" "cwd-changed"
}

@test "golden: lifecycle-state/task-created" {
	_run_fixture "lifecycle-state" "task-created"
}

@test "golden: notify/idle-prompt" {
	_run_fixture "notify" "idle-prompt"
}

@test "golden: notify/permission-prompt" {
	_run_fixture "notify" "permission-prompt"
}

@test "golden: package-plugin/dry-run" {
	_run_fixture "package-plugin" "dry-run"
}

@test "golden: permission-filter/allow-npm" {
	_run_fixture "permission-filter" "allow-npm"
}

@test "golden: permission-filter/deny-rm-rf" {
	_run_fixture "permission-filter" "deny-rm-rf"
}

@test "golden: permission-filter/allow-jq" {
	_run_fixture "permission-filter" "allow-jq"
}

@test "golden: plan-mode-handler/exit-plan-mode" {
	_run_fixture "plan-mode-handler" "exit-plan-mode"
}

@test "golden: plan-mode-handler/other-tool" {
	_run_fixture "plan-mode-handler" "other-tool"
}

@test "golden: post-compact-inject/no-context-file" {
	_run_fixture "post-compact-inject" "no-context-file"
}

@test "golden: post-compact-log/with-summary" {
	_run_fixture "post-compact-log" "with-summary"
}

@test "golden: post-compact-log/no-summary" {
	_run_fixture "post-compact-log" "no-summary"
}

@test "golden: post-edit/write-event" {
	_run_fixture "post-edit" "write-event"
}

@test "golden: post-edit/edit-event" {
	_run_fixture "post-edit" "edit-event"
}

@test "golden: pre-compact/happy-path" {
	_run_fixture "pre-compact" "happy-path"
}

@test "golden: pre-compact/ralph-active" {
	_run_fixture "pre-compact" "ralph-active"
}

@test "golden: ralph-persistence/no-ralph" {
	_run_fixture "ralph-persistence" "no-ralph"
}

@test "golden: ralph-persistence/ralph-active" {
	_run_fixture "ralph-persistence" "ralph-active"
}

@test "golden: ralph-persistence/recursion-guard" {
	_run_fixture "ralph-persistence" "recursion-guard"
}

@test "golden: ralph-persistence/stagnated" {
	_run_fixture "ralph-persistence" "stagnated"
}

@test "golden: read-error-recovery/file-not-found" {
	_run_fixture "read-error-recovery" "file-not-found"
}

@test "golden: read-error-recovery/is-directory" {
	_run_fixture "read-error-recovery" "is-directory"
}

@test "golden: session-cleanup/normal" {
	_run_fixture "session-cleanup" "normal"
}

@test "golden: session-cleanup/resume" {
	_run_fixture "session-cleanup" "resume"
}

@test "golden: session-init/startup" {
	_run_fixture "session-init" "startup"
}

@test "golden: session-init/compact" {
	_run_fixture "session-init" "compact"
}

@test "golden: stop-failure-handler/no-active-mode" {
	_run_fixture "stop-failure-handler" "no-active-mode"
}

@test "golden: stop-failure-handler/ralph-active" {
	_run_fixture "stop-failure-handler" "ralph-active"
}

@test "golden: subagent-complete/completed" {
	_run_fixture "subagent-complete" "completed"
}

@test "golden: subagent-start/sisyphus" {
	_run_fixture "subagent-start" "sisyphus"
}

@test "golden: subagent-start/executor" {
	_run_fixture "subagent-start" "executor"
}

@test "golden: subagent-start/explore" {
	_run_fixture "subagent-start" "explore"
}

@test "golden: task-completed-verify/no-evidence" {
	_run_fixture "task-completed-verify" "no-evidence"
}

@test "golden: task-completed-verify/with-evidence" {
	_run_fixture "task-completed-verify" "with-evidence"
}

@test "golden: teammate-idle-guard/no-active-mode" {
	_run_fixture "teammate-idle-guard" "no-active-mode"
}

@test "golden: teammate-idle-guard/ralph-active" {
	_run_fixture "teammate-idle-guard" "ralph-active"
}

@test "golden: track-question/happy-path" {
	_run_fixture "track-question" "happy-path"
}

@test "golden: track-subagent-spawn/spawn-executor" {
	_run_fixture "track-subagent-spawn" "spawn-executor"
}

@test "golden: validate-plugin/known-good" {
	_run_fixture "validate-plugin" "known-good"
}

@test "golden: write-guard/evidence-file" {
	_run_fixture "write-guard" "evidence-file"
}

@test "golden: write-guard/existing-file" {
	_run_fixture "write-guard" "existing-file"
}

@test "golden: write-guard/new-file" {
	_run_fixture "write-guard" "new-file"
}
