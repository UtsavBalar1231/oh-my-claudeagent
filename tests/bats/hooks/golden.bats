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

@test "golden: package-plugin/dry-run" {
	_run_fixture "package-plugin" "dry-run"
}

@test "golden: validate-plugin/known-good" {
	_run_fixture "validate-plugin" "known-good"
}
