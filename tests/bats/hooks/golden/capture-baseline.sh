#!/usr/bin/env bash
# capture-baseline.sh — captures or compares golden-output baselines for all hook fixtures.
#
# Usage:
#   capture-baseline.sh              — capture baselines (first run or re-capture)
#   capture-baseline.sh --dry-run    — list all fixture variants without running hooks
#   capture-baseline.sh --compare    — run each hook, diff against checked-in baseline
#
# Each hook is invoked with env -i + explicit env-var whitelist so that the caller's
# shell environment (including a leaked CLAUDE_SESSION_ID) cannot pollute captures.

# No set -euo pipefail — consistent with hook-scripts.md convention.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/fixtures"
BASELINE_DIR="${SCRIPT_DIR}/baseline"
NORMALIZERS_DIR="${SCRIPT_DIR}/normalizers"
NORMALIZE_SH="${SCRIPT_DIR}/normalize.sh"

# Resolve the repo (plugin) root — two levels up from tests/bats/hooks/golden/
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HOOKS_DIR="${PLUGIN_ROOT}/scripts"

MODE="capture"
if [[ "${1:-}" == "--dry-run" ]]; then
	MODE="dry-run"
elif [[ "${1:-}" == "--compare" ]]; then
	MODE="compare"
fi

# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

normalize_stream() {
	local hook_name="$1"
	local custom="${NORMALIZERS_DIR}/${hook_name}.sh"
	if [[ -x "${custom}" ]]; then
		bash "${NORMALIZE_SH}" | bash "${custom}"
	else
		bash "${NORMALIZE_SH}"
	fi
}

# Compute the fixture-local session ID for use in env -i invocation.
# Reads session_id from the fixture's input.json; falls back to fixture-sid-fallback.
fixture_sid() {
	local fixture_input="$1"
	local sid
	sid=$(jq -r '.session_id // "fixture-sid-fallback"' "${fixture_input}" 2>/dev/null)
	printf '%s' "${sid}"
}

# Run one hook variant.
# $1 = hook script basename (e.g. keyword-detector.sh)
# $2 = fixture directory (absolute path)
# $3 = work tmpdir for this invocation
# Outputs: stdout_file, stderr_file, exit_code_file, state_diff_file under $3/out/
run_hook_variant() {
	local hook_script="$1"
	local fixture_dir="$2"
	local work_dir="$3"
	local hook_name
	hook_name=$(basename "${hook_script}" .sh)

	local input_json="${fixture_dir}/input.json"
	local out_dir="${work_dir}/out"
	mkdir -p "${out_dir}"

	# Prepare hermetic state directory
	local state_dir="${work_dir}/.omca/state"
	local log_dir="${work_dir}/.omca/logs"
	mkdir -p "${state_dir}" "${log_dir}"

	# Extract seed-state if present
	local seed="${fixture_dir}/seed-state.tar"
	if [[ -f "${seed}" ]]; then
		(cd "${work_dir}" && tar xf "${seed}" 2>/dev/null)
	fi

	# Snapshot state dir before run (for diff)
	local before_dir="${work_dir}/state-before"
	cp -r "${state_dir}" "${before_dir}" 2>/dev/null || mkdir -p "${before_dir}"

	local sid
	sid=$(fixture_sid "${input_json}")
	local hook_input
	hook_input=$(cat "${input_json}")

	local hook_path="${HOOKS_DIR}/${hook_script}"

	# Special handling for CLI-mode fixtures (validate-plugin.sh, package-plugin.sh)
	local cli_mode
	cli_mode=$(jq -r '._cli_mode // false' "${input_json}" 2>/dev/null)
	local extra_args=""
	if [[ "${cli_mode}" == "true" ]]; then
		extra_args=$(jq -r '.args | if type == "array" then .[] else empty end' "${input_json}" 2>/dev/null | tr '\n' ' ')
	fi

	local exit_code=0
	if [[ "${cli_mode}" == "true" ]]; then
		# CLI scripts: invoke with env -i but pass args, no stdin payload
		# shellcheck disable=SC2086
		env -i \
			PATH="${PATH}" \
			HOME="${HOME}" \
			CLAUDE_PROJECT_ROOT="${work_dir}" \
			HOOK_PROJECT_ROOT="${work_dir}" \
			HOOK_STATE_DIR="${state_dir}" \
			HOOK_LOG_DIR="${log_dir}" \
			bash "${hook_path}" ${extra_args} \
			>"${out_dir}/stdout.raw" 2>"${out_dir}/stderr.raw"
		exit_code=$?
	else
		# Hook scripts: invoke via stdin with env -i
		env -i \
			PATH="${PATH}" \
			HOME="${HOME}" \
			CLAUDE_SESSION_ID="${sid}" \
			HOOK_INPUT="${hook_input}" \
			CLAUDE_PROJECT_ROOT="${work_dir}" \
			HOOK_PROJECT_ROOT="${work_dir}" \
			HOOK_STATE_DIR="${state_dir}" \
			HOOK_LOG_DIR="${log_dir}" \
			bash "${hook_path}" <<< "${hook_input}" \
			>"${out_dir}/stdout.raw" 2>"${out_dir}/stderr.raw"
		exit_code=$?
	fi

	printf '%d\n' "${exit_code}" > "${out_dir}/exit_code.txt"

	# Compute state diff (normalized paths → portable across machines)
	local after_dir="${work_dir}/state-after"
	cp -r "${state_dir}" "${after_dir}" 2>/dev/null || mkdir -p "${after_dir}"
	diff -ru "${before_dir}" "${after_dir}" 2>/dev/null \
		| sed "s|${work_dir}||g" \
		> "${out_dir}/state-diff.raw" || true

	# Normalize all streams
	normalize_stream "${hook_name}" < "${out_dir}/stdout.raw" > "${out_dir}/stdout.txt"
	normalize_stream "${hook_name}" < "${out_dir}/stderr.raw" > "${out_dir}/stderr.txt"
	normalize_stream "${hook_name}" < "${out_dir}/state-diff.raw" > "${out_dir}/state-diff.txt"
}

# -------------------------------------------------------------------
# Main loop — iterate fixtures in deterministic (sorted) order
# -------------------------------------------------------------------

FIXTURE_COUNT=0
COMPARE_DIFFS=0

while IFS= read -r input_json; do
	fixture_dir=$(dirname "${input_json}")
	variant=$(basename "${fixture_dir}")
	hook_dir=$(dirname "${fixture_dir}")
	hook_name=$(basename "${hook_dir}")
	hook_script="${hook_name}.sh"

	# Skip placeholder CLI-mode fixtures for hooks that don't exist as scripts
	hook_path="${HOOKS_DIR}/${hook_script}"
	if [[ ! -f "${hook_path}" ]]; then
		continue
	fi

	FIXTURE_COUNT=$((FIXTURE_COUNT + 1))

	if [[ "${MODE}" == "dry-run" ]]; then
		printf '%s/%s\n' "${hook_name}" "${variant}"
		continue
	fi

	work_dir=$(mktemp -d)
	run_hook_variant "${hook_script}" "${fixture_dir}" "${work_dir}"

	if [[ "${MODE}" == "capture" ]]; then
		dest="${BASELINE_DIR}/${hook_name}/${variant}"
		mkdir -p "${dest}"
		cp "${work_dir}/out/stdout.txt"     "${dest}/stdout.txt"
		cp "${work_dir}/out/stderr.txt"     "${dest}/stderr.txt"
		cp "${work_dir}/out/exit_code.txt"  "${dest}/exit_code.txt"
		cp "${work_dir}/out/state-diff.txt" "${dest}/state-diff.txt"

	elif [[ "${MODE}" == "compare" ]]; then
		baseline="${BASELINE_DIR}/${hook_name}/${variant}"
		VARIANT_DIFF=0
		for part in stdout stderr exit_code state-diff; do
			baseline_file="${baseline}/${part}.txt"
			fresh_file="${work_dir}/out/${part}.txt"
			if [[ ! -f "${baseline_file}" ]]; then
				printf 'MISSING BASELINE: %s/%s/%s.txt\n' "${hook_name}" "${variant}" "${part}" >&2
				VARIANT_DIFF=$((VARIANT_DIFF + 1))
				continue
			fi
			if ! diff -u "${baseline_file}" "${fresh_file}" > "${work_dir}/diff-${part}.txt" 2>&1; then
				printf 'DIFF: %s/%s/%s\n' "${hook_name}" "${variant}" "${part}" >&2
				cat "${work_dir}/diff-${part}.txt" >&2
				VARIANT_DIFF=$((VARIANT_DIFF + 1))
			fi
		done
		if [[ "${VARIANT_DIFF}" -gt 0 ]]; then
			COMPARE_DIFFS=$((COMPARE_DIFFS + VARIANT_DIFF))
		fi
	fi

	rm -rf "${work_dir}"

done < <(find "${FIXTURES_DIR}" -name "input.json" | sort)

if [[ "${MODE}" == "dry-run" ]]; then
	printf 'Fixtures: %d variants\n' "${FIXTURE_COUNT}"
elif [[ "${MODE}" == "capture" ]]; then
	printf 'Captured baselines for %d fixture variants.\n' "${FIXTURE_COUNT}"
elif [[ "${MODE}" == "compare" ]]; then
	if [[ "${COMPARE_DIFFS}" -eq 0 ]]; then
		printf 'All %d fixture variants match baseline. Zero diff.\n' "${FIXTURE_COUNT}"
	else
		printf 'COMPARE FAILED: %d diff(s) across %d variants.\n' "${COMPARE_DIFFS}" "${FIXTURE_COUNT}" >&2
		exit 1
	fi
fi
