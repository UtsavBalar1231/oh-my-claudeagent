#!/bin/bash
# scripts/qa/install-verify.sh — static/structural checks against a PACKAGED plugin
# copy: does the artifact a user would actually install pass validation, resolve its
# own hook paths, and serve a working MCP handshake. No `claude` session is launched
# here (no drift risk), except `claude plugin validate` which only reads the path.
#
# Usage: scripts/qa/install-verify.sh [--self-test]

QA_DIR="$(cd "$(dirname "$0")" && pwd)"
QA_ROOT="$(cd "${QA_DIR}/../.." && pwd)"
# shellcheck source=lib/qa-common.sh
source "${QA_DIR}/lib/qa-common.sh"

MCP_FIXTURES_DIR="${QA_ROOT}/tests/fixtures/mcp"

# check_plugin_validate <package_dir> — `claude plugin validate` is the platform's own
# headless manifest check (confirmed via `claude plugin --help`); prefer it over
# reimplementing manifest structural checks.
check_plugin_validate() {
	local package_dir="$1"
	local out
	if out=$(claude plugin validate "${package_dir}" 2>&1); then
		qa_pass "claude plugin validate: ${package_dir}"
	else
		qa_fail "claude plugin validate failed: ${out}"
	fi
}

# check_hook_script_paths <package_dir> — every ${CLAUDE_PLUGIN_ROOT}/... command in
# hooks.json must resolve to a real file inside the package.
check_hook_script_paths() {
	local package_dir="$1"
	local hooks_json="${package_dir}/hooks/hooks.json"
	if [[ ! -f "${hooks_json}" ]]; then
		qa_fail "hooks.json missing from packaged tree at ${hooks_json}"
		return
	fi
	local missing=0 checked=0
	local cmd rel_path
	while IFS= read -r cmd; do
		[[ -z "${cmd}" ]] && continue
		checked=$((checked + 1))
		# Handlers quote the placeholder so a space in the install path survives
		# word splitting. The shell strips those quotes before exec; this check
		# must do the same or every path resolves to a nonexistent file.
		if [[ "${cmd}" == '"'*'"' ]]; then
			cmd="${cmd:1:${#cmd}-2}"
		fi
		rel_path="${cmd#\$\{CLAUDE_PLUGIN_ROOT\}/}"
		if [[ ! -f "${package_dir}/${rel_path}" ]]; then
			qa_fail "hook command does not resolve in package: ${cmd}"
			missing=$((missing + 1))
		elif [[ ! -x "${package_dir}/${rel_path}" ]]; then
			# Shell form honors the shebang, so a lost executable bit surfaces
			# only once the platform tries to spawn the handler.
			qa_fail "hook script is not executable in package: ${cmd}"
			missing=$((missing + 1))
		fi
	done < <(jq -r '[.. | objects | select(.type? == "command") | .command] | .[]' "${hooks_json}")
	if [[ "${checked}" -eq 0 ]]; then
		qa_fail "no command hooks found to check in ${hooks_json}"
	elif [[ "${missing}" -eq 0 ]]; then
		qa_pass "all ${checked} hook command paths resolve and are executable inside the packaged tree"
	fi
}

# check_mcp_handshake <package_dir> — same initialize/tools-list handshake
# scripts/validate-plugin.sh runs against the dev checkout, pointed at the PACKAGED
# servers/ copy instead, so a packaging bug (missing file, broken exclude) is caught
# in the artifact a user actually installs.
check_mcp_handshake() {
	local package_dir="$1"
	local mcp_server_project="${package_dir}/servers"
	if [[ ! -d "${mcp_server_project}" ]]; then
		qa_fail "packaged servers/ directory missing at ${mcp_server_project}"
		return
	fi

	local mcp_tmp stdout_file stderr_file mcp_status
	mcp_tmp="$(mktemp -d)"
	stdout_file="${mcp_tmp}/stdout.jsonl"
	stderr_file="${mcp_tmp}/stderr.log"

	{
		cat "${MCP_FIXTURES_DIR}/initialize.json" || true
		printf '\n'
		cat "${MCP_FIXTURES_DIR}/initialized-notification.json" || true
		printf '\n'
		cat "${MCP_FIXTURES_DIR}/tools-list.json" || true
		printf '\n'
	} | timeout 45 uv run --project "${mcp_server_project}" python "${mcp_server_project}/omca-mcp.py" >"${stdout_file}" 2>"${stderr_file}"
	mcp_status=$?

	if [[ "${mcp_status}" -ne 0 ]]; then
		qa_fail "packaged mcp handshake exited ${mcp_status}: $(sed -n '1,8p' "${stderr_file}")"
		rm -rf "${mcp_tmp}"
		return
	fi
	if jq -s -e 'map(select(.id == 1)) | length >= 1' "${stdout_file}" >/dev/null 2>&1; then
		qa_pass "packaged mcp server: initialize response received"
	else
		qa_fail "packaged mcp server: initialize response missing"
	fi
	if jq -s -e 'map(select(.id == 2)) | length >= 1' "${stdout_file}" >/dev/null 2>&1; then
		qa_pass "packaged mcp server: tools/list response received"
	else
		qa_fail "packaged mcp server: tools/list response missing"
	fi
	rm -rf "${mcp_tmp}"
}

# check_claudemd_template <package_dir> — templates/claudemd.md must ship; skills
# reference it at runtime (see skills/omca-setup/SKILL.md).
check_claudemd_template() {
	local package_dir="$1"
	if [[ -f "${package_dir}/templates/claudemd.md" ]]; then
		qa_pass "templates/claudemd.md present in packaged tree"
	else
		qa_fail "templates/claudemd.md missing from packaged tree"
	fi
}

run_all_checks() {
	local package_dir="$1"
	check_plugin_validate "${package_dir}"
	check_hook_script_paths "${package_dir}"
	check_mcp_handshake "${package_dir}"
	check_claudemd_template "${package_dir}"
}

self_test() {
	echo "[install-verify --self-test] clean package passes"
	local pkg
	pkg="$(qa_build_package)"
	# qa_build_package runs in the $() subshell above, so its own QA_CLEANUP_DIRS
	# append never reaches this process; register here instead.
	QA_CLEANUP_DIRS+=("${pkg}")
	run_all_checks "${pkg}"

	echo "[install-verify --self-test] sabotage proof: remove a hook script from a COPY"
	local sabotage_dir
	sabotage_dir="$(mktemp -d "${TMPDIR:-/tmp}/qa-sabotage-XXXXXX")"
	cp -a "${pkg}/." "${sabotage_dir}/"
	rm -f "${sabotage_dir}/scripts/write-guard.sh"
	local sabotage_out
	# Run inside a command-substitution subshell: check_hook_script_paths's own FAIL
	# (the expected trigger) increments a subshell-local QA_FAIL_COUNT that never
	# leaks back to this process, so the self-test's own tally stays clean.
	sabotage_out="$(check_hook_script_paths "${sabotage_dir}" 2>&1)"
	if grep -q 'does not resolve in package' <<<"${sabotage_out}"; then
		qa_pass "sabotaged package (missing hook script) correctly failed install-verify"
	else
		qa_fail "sabotaged package did NOT fail install-verify — guard is not effective"
	fi
	rm -rf "${sabotage_dir}"
}

if [[ "${1:-}" == "--self-test" ]]; then
	trap qa_teardown EXIT
	qa_drift_capture
	self_test
	qa_log "install-verify self-test: ${QA_PASS_COUNT} passed, ${QA_FAIL_COUNT} failed"
	[[ "${QA_FAIL_COUNT}" -eq 0 ]]
	exit $?
fi

trap qa_teardown EXIT
qa_drift_capture
PACKAGE_DIR="$(qa_build_package)"
# See self_test() above: qa_build_package's own append is lost in the $() subshell.
QA_CLEANUP_DIRS+=("${PACKAGE_DIR}")
run_all_checks "${PACKAGE_DIR}"
qa_log "install-verify: ${QA_PASS_COUNT} passed, ${QA_FAIL_COUNT} failed"
[[ "${QA_FAIL_COUNT}" -eq 0 ]]
