#!/bin/bash
# Standalone development utility — not a hook script (ADR-009 does not apply)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

HOOKS_JSON="${REPO_ROOT}/hooks/hooks.json"
PLUGIN_JSON="${REPO_ROOT}/.claude-plugin/plugin.json"
DEFAULT_MARKETPLACE_JSON="${REPO_ROOT}/.claude-plugin/marketplace.json"
MCP_JSON="${REPO_ROOT}/.mcp.json"
HOOK_FIXTURES_DIR="${REPO_ROOT}/tests/fixtures/hooks"
MCP_FIXTURES_DIR="${REPO_ROOT}/tests/fixtures/mcp"
MCP_SERVER_PROJECT="${REPO_ROOT}/servers"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

MARKETPLACE_PATH="${DEFAULT_MARKETPLACE_JSON}"
MARKETPLACE_OVERRIDE=0
HOOK_CASE=""

declare -a CHECKS=()

log() {
	printf '[validate-plugin] %s\n' "$1"
}

pass() {
	PASS_COUNT=$((PASS_COUNT + 1))
	log "PASS: $1"
}

fail() {
	FAIL_COUNT=$((FAIL_COUNT + 1))
	log "FAIL: $1"
}

skip() {
	SKIP_COUNT=$((SKIP_COUNT + 1))
	log "SKIP: $1"
}

usage() {
	cat <<'USAGE'
Usage: bash scripts/validate-plugin.sh [options]

Options:
  --check <claims|hooks|mcp>   Run a specific check (repeatable)
  --case <name>                Named hook scenario (supports: compaction-race)
  --marketplace <path>         Override marketplace JSON path
  --help                       Show this help text

Defaults:
  - No --check flags -> runs claims, hooks, and mcp checks
  - --case applies only to hooks checks
USAGE
}

contains_check() {
	local needle="$1"
	local item
	for item in "${CHECKS[@]}"; do
		if [[ "${item}" == "${needle}" ]]; then
			return 0
		fi
	done
	return 1
}

validate_json_file() {
	local file_path="$1"
	local label="$2"

	if [[ ! -f "${file_path}" ]]; then
		fail "${label}: missing file at ${file_path}"
		return 1
	fi

	if jq . "${file_path}" >/dev/null 2>&1; then
		pass "${label}: valid JSON (${file_path})"
		return 0
	fi

	fail "${label}: invalid JSON (${file_path})"
	return 1
}

resolve_hook_commands() {
	local event_name="$1"
	local matcher_value="$2"

	if [[ -n "${matcher_value}" ]]; then
		jq -r --arg event "${event_name}" --arg matcher "${matcher_value}" '
			.hooks[$event][]?
			| select((.matcher // "") == $matcher)
			| .hooks[]?.command // empty
		' "${HOOKS_JSON}"
		return 0
	fi

	jq -r --arg event "${event_name}" '
		.hooks[$event][]?
		| select((has("matcher") | not) or (.matcher == null) or (.matcher == ""))
		| .hooks[]?.command // empty
	' "${HOOKS_JSON}"
}

resolve_hook_path() {
	local raw_command="$1"
	printf '%s' "${raw_command//\$\{CLAUDE_PLUGIN_ROOT\}/${REPO_ROOT}}"
}

run_script_with_payload() {
	local label="$1"
	local script_path="$2"
	local payload_path="$3"
	local project_root="$4"
	local output_expectation="$5"

	local run_dir
	run_dir="$(mktemp -d)"
	local stdout_file="${run_dir}/stdout.txt"
	local stderr_file="${run_dir}/stderr.txt"

	CLAUDE_PROJECT_ROOT="${project_root}" \
		CLAUDE_PLUGIN_ROOT="${REPO_ROOT}" \
		CLAUDE_SESSION_ID="validate-plugin-session" \
		bash "${script_path}" <"${payload_path}" >"${stdout_file}" 2>"${stderr_file}"
	local exit_code=$?

	if [[ "${exit_code}" -ne 0 ]]; then
		local stderr_excerpt
		stderr_excerpt="$(sed -n '1,5p' "${stderr_file}" 2>/dev/null)"
		fail "${label}: script exited ${exit_code}${stderr_excerpt:+ (${stderr_excerpt})}"
		rm -rf "${run_dir}"
		return 1
	fi

	case "${output_expectation}" in
	json-required)
		if [[ ! -s "${stdout_file}" ]]; then
			fail "${label}: expected JSON output but received empty stdout"
			rm -rf "${run_dir}"
			return 1
		fi
		if ! jq . "${stdout_file}" >/dev/null 2>&1; then
			fail "${label}: stdout is not valid JSON"
			rm -rf "${run_dir}"
			return 1
		fi
		pass "${label}: script succeeded with valid JSON output"
		;;
	json-optional)
		if [[ -s "${stdout_file}" ]] && ! jq . "${stdout_file}" >/dev/null 2>&1; then
			fail "${label}: optional stdout present but invalid JSON"
			rm -rf "${run_dir}"
			return 1
		fi
		pass "${label}: script succeeded"
		;;
	text-any)
		pass "${label}: script succeeded"
		;;
	empty)
		if [[ -s "${stdout_file}" ]]; then
			fail "${label}: expected empty stdout"
			rm -rf "${run_dir}"
			return 1
		fi
		pass "${label}: script succeeded with empty stdout"
		;;
	*)
		fail "${label}: unknown output expectation '${output_expectation}'"
		rm -rf "${run_dir}"
		return 1
		;;
	esac

	rm -rf "${run_dir}"
	return 0
}

run_registered_hooks() {
	local label="$1"
	local event_name="$2"
	local matcher_value="$3"
	local payload_path="$4"
	local project_root="$5"
	local output_expectation="$6"

	local commands
	commands="$(resolve_hook_commands "${event_name}" "${matcher_value}")"

	if [[ -z "${commands}" ]]; then
		skip "${label}: no matching hook command registered"
		return 2
	fi

	local script_command
	while IFS= read -r script_command; do
		[[ -z "${script_command}" ]] && continue
		local script_path
		script_path="$(resolve_hook_path "${script_command}")"

		if [[ ! -f "${script_path}" ]]; then
			fail "${label}: hook command points to missing script (${script_path})"
			continue
		fi

		run_script_with_payload "${label} ($(basename "${script_path}"))" "${script_path}" "${payload_path}" "${project_root}" "${output_expectation}"
	done <<<"${commands}"

	return 0
}

check_claims() {
	log "Running claims checks"

	validate_json_file "${HOOKS_JSON}" "hooks contract"
	validate_json_file "${PLUGIN_JSON}" "plugin manifest"
	validate_json_file "${MARKETPLACE_PATH}" "marketplace manifest"
	validate_json_file "${MCP_JSON}" "mcp registry"

	if jq -e '.hooks | type == "object"' "${HOOKS_JSON}" >/dev/null 2>&1; then
		pass "hooks registry has object root"
	else
		fail "hooks registry missing object root"
	fi

	if jq -e '.name == "oh-my-claudeagent"' "${PLUGIN_JSON}" >/dev/null 2>&1; then
		pass "plugin manifest declares expected package name"
	else
		fail "plugin manifest name mismatch"
	fi

	if jq -e '.plugins | map(.name) | index("oh-my-claudeagent") != null' "${MARKETPLACE_PATH}" >/dev/null 2>&1; then
		pass "marketplace includes oh-my-claudeagent entry"
	else
		fail "marketplace missing oh-my-claudeagent entry"
	fi

	if [[ "${MARKETPLACE_OVERRIDE}" -eq 1 ]]; then
		if jq -e '.plugins[] | if (.source | type) == "string" then (.source | startswith("./")) else true end' "${MARKETPLACE_PATH}" >/dev/null 2>&1; then
			pass "override marketplace enforces ./ source path rule"
		else
			fail "override marketplace violates ./ source path rule"
		fi
	else
		if jq -e '.plugins[] | if (.source | type) == "string" then (.source == "." or (.source | startswith("./"))) else true end' "${MARKETPLACE_PATH}" >/dev/null 2>&1; then
			pass "default marketplace source path is accepted by current contract"
		else
			fail "default marketplace source path check failed"
		fi
	fi

	if jq -e '.mcpServers["omca"].command == "uv"' "${MCP_JSON}" >/dev/null 2>&1; then
		pass "mcp registry uses uv for omca server"
	else
		fail "mcp registry omca command should be 'uv'"
	fi

	# Validate config files
	validate_json_file "${REPO_ROOT}/servers/categories.json" "categories config"
	validate_json_file "${REPO_ROOT}/servers/agent-metadata.json" "agent metadata"

	# Verify old server files were removed
	if [[ ! -f "${REPO_ROOT}/servers/ast-grep-server.py" ]]; then
		pass "ast-grep-server.py removed"
	else
		fail "ast-grep-server.py still exists (should have been removed)"
	fi
	if [[ ! -f "${REPO_ROOT}/servers/omca-state-server.py" ]]; then
		pass "omca-state-server.py removed"
	else
		fail "omca-state-server.py still exists (should have been removed)"
	fi
}

check_hook_fixtures_exist() {
	local fixtures=(
		"pretooluse-task-agent.json"
		"pretooluse-write.json"
		"permissionrequest-bash.json"
		"permissionrequest-exitplanmode.json"
		"sessionstart-compact.json"
		"instructionsloaded-basic.json"
		"taskcompleted-basic.json"
		"teammateidle-basic.json"
		"userpromptsubmit-ralph.json"
		"userpromptsubmit-ultrawork.json"
		"stop-basic.json"
		"subagentstart-basic.json"
		"subagentstopcomplete-basic.json"
	)

	local file_name
	for file_name in "${fixtures[@]}"; do
		validate_json_file "${HOOK_FIXTURES_DIR}/${file_name}" "hook fixture ${file_name}"
	done
}

run_compaction_race_case() {
	local payload_path="$1"
	local project_root="$2"

	local session_script="${REPO_ROOT}/scripts/session-init.sh"
	local post_script="${REPO_ROOT}/scripts/post-compact-inject.sh"

	if [[ ! -f "${session_script}" ]] || [[ ! -f "${post_script}" ]]; then
		fail "compaction-race case requires session-init.sh and post-compact-inject.sh"
		return 1
	fi

	mkdir -p "${project_root}/.omca/state" "${project_root}/.omca/logs"
	printf 'fixture compaction context' >"${project_root}/.omca/state/compaction-context.md"

	local race_dir
	race_dir="$(mktemp -d)"
	local session_out="${race_dir}/session.out"
	local session_err="${race_dir}/session.err"
	local post_out="${race_dir}/post.out"
	local post_err="${race_dir}/post.err"
	local post_second_out="${race_dir}/post-second.out"
	local post_second_err="${race_dir}/post-second.err"
	local session_context_file="${race_dir}/session-context.txt"
	local post_context_file="${race_dir}/post-context.txt"

	CLAUDE_PROJECT_ROOT="${project_root}" CLAUDE_PLUGIN_ROOT="${REPO_ROOT}" CLAUDE_SESSION_ID="race-session" bash "${session_script}" <"${payload_path}" >"${session_out}" 2>"${session_err}" &
	local pid1=$!
	CLAUDE_PROJECT_ROOT="${project_root}" CLAUDE_PLUGIN_ROOT="${REPO_ROOT}" CLAUDE_SESSION_ID="race-session" bash "${post_script}" <"${payload_path}" >"${post_out}" 2>"${post_err}" &
	local pid2=$!

	wait "${pid1}"
	local status1=$?
	wait "${pid2}"
	local status2=$?

	if [[ "${status1}" -ne 0 ]] || [[ "${status2}" -ne 0 ]]; then
		fail "compaction-race case: scripts exited with non-zero status (${status1}, ${status2})"
		rm -rf "${race_dir}"
		return 1
	fi

	if [[ -s "${session_out}" ]] && ! jq . "${session_out}" >/dev/null 2>&1; then
		fail "compaction-race case: session-init output is not valid JSON"
		rm -rf "${race_dir}"
		return 1
	fi

	if [[ -s "${post_out}" ]] && ! jq . "${post_out}" >/dev/null 2>&1; then
		fail "compaction-race case: post-compact-inject output is not valid JSON"
		rm -rf "${race_dir}"
		return 1
	fi

	if [[ ! -s "${session_out}" ]]; then
		fail "compaction-race case: session-init produced empty output"
		rm -rf "${race_dir}"
		return 1
	fi

	if [[ ! -s "${post_out}" ]]; then
		fail "compaction-race case: first post-compact restore produced empty output"
		rm -rf "${race_dir}"
		return 1
	fi

	jq -r '.hookSpecificOutput.additionalContext // ""' "${session_out}" >"${session_context_file}"
	jq -r '.hookSpecificOutput.additionalContext // ""' "${post_out}" >"${post_context_file}"

	if grep -q 'Post-compaction state detected\|POST-COMPACTION CONTEXT RESTORE\|fixture compaction context' "${session_context_file}"; then
		fail "compaction-race case: session-init still handled compaction restore content"
		rm -rf "${race_dir}"
		return 1
	fi

	if ! grep -q 'fixture compaction context' "${post_context_file}"; then
		fail "compaction-race case: post-compact-inject did not restore compaction context"
		rm -rf "${race_dir}"
		return 1
	fi

	if [[ -f "${project_root}/.omca/state/compaction-context.md" ]]; then
		fail "compaction-race case: compaction context file still exists after restore"
		rm -rf "${race_dir}"
		return 1
	fi

	CLAUDE_PROJECT_ROOT="${project_root}" CLAUDE_PLUGIN_ROOT="${REPO_ROOT}" CLAUDE_SESSION_ID="race-session" bash "${post_script}" >"${post_second_out}" 2>"${post_second_err}"
	local status3=$?

	if [[ "${status3}" -ne 0 ]]; then
		fail "compaction-race case: second post-compact-inject exited with non-zero status (${status3})"
		rm -rf "${race_dir}"
		return 1
	fi

	if [[ -s "${post_second_out}" ]]; then
		fail "compaction-race case: second post-compact-inject should not emit duplicate restore output"
		rm -rf "${race_dir}"
		return 1
	fi

	pass "compaction-race case executed with valid outputs"
	rm -rf "${race_dir}"
	return 0
}

check_hooks() {
	log "Running hooks checks"

	validate_json_file "${HOOKS_JSON}" "hooks contract"
	check_hook_fixtures_exist

	local tmp_root
	tmp_root="$(mktemp -d)"
	mkdir -p "${tmp_root}/.omca/state" "${tmp_root}/.omca/logs"

	local pretool_task_payload="${HOOK_FIXTURES_DIR}/pretooluse-task-agent.json"
	local pretool_write_payload="${tmp_root}/pretooluse-write.runtime.json"
	local permission_payload="${HOOK_FIXTURES_DIR}/permissionrequest-bash.json"
	local exitplanmode_payload="${HOOK_FIXTURES_DIR}/permissionrequest-exitplanmode.json"
	local session_compact_payload="${HOOK_FIXTURES_DIR}/sessionstart-compact.json"
	local instructions_payload="${HOOK_FIXTURES_DIR}/instructionsloaded-basic.json"
	local task_payload="${HOOK_FIXTURES_DIR}/taskcompleted-basic.json"
	local teammate_payload="${HOOK_FIXTURES_DIR}/teammateidle-basic.json"

	local existing_file="${tmp_root}/existing.txt"
	touch "${existing_file}"
	jq --arg file "${existing_file}" '.tool_input.file_path = $file' "${HOOK_FIXTURES_DIR}/pretooluse-write.json" >"${pretool_write_payload}"

	run_registered_hooks "PreToolUse Task|Agent" "PreToolUse" "Task|Agent" "${pretool_task_payload}" "${tmp_root}" "json-required"
	run_registered_hooks "PreToolUse Write" "PreToolUse" "Write" "${pretool_write_payload}" "${tmp_root}" "json-required"
	run_registered_hooks "PermissionRequest Bash" "PermissionRequest" "Bash" "${permission_payload}" "${tmp_root}" "json-required"
	run_registered_hooks "PermissionRequest ExitPlanMode" "PermissionRequest" "ExitPlanMode" "${exitplanmode_payload}" "${tmp_root}" "json-required"

	printf 'compact fixture context' >"${tmp_root}/.omca/state/compaction-context.md"
	run_registered_hooks "SessionStart compact" "SessionStart" "compact" "${session_compact_payload}" "${tmp_root}" "json-required"

	run_registered_hooks "TaskCompleted default" "TaskCompleted" "" "${task_payload}" "${tmp_root}" "empty"
	run_registered_hooks "TeammateIdle default" "TeammateIdle" "" "${teammate_payload}" "${tmp_root}" "empty"

	run_registered_hooks "InstructionsLoaded default" "InstructionsLoaded" "" "${instructions_payload}" "${tmp_root}" "json-optional"

	# UserPromptSubmit: keyword-detector should produce JSON with additionalContext
	local ralph_payload="${HOOK_FIXTURES_DIR}/userpromptsubmit-ralph.json"
	local ultrawork_payload="${HOOK_FIXTURES_DIR}/userpromptsubmit-ultrawork.json"
	run_registered_hooks "UserPromptSubmit ralph" "UserPromptSubmit" "" "${ralph_payload}" "${tmp_root}" "json-required"
	# Verify keyword-detector creates ralph-state.json
	if [[ -f "${tmp_root}/.omca/state/ralph-state.json" ]]; then
		if jq -e '.status == "active"' "${tmp_root}/.omca/state/ralph-state.json" >/dev/null 2>&1; then
			pass "keyword-detector creates ralph-state.json with active status"
		else
			fail "keyword-detector created ralph-state.json but status is not active"
		fi
	else
		fail "keyword-detector should create ralph-state.json on ralph keyword"
	fi

	run_registered_hooks "UserPromptSubmit ultrawork" "UserPromptSubmit" "" "${ultrawork_payload}" "${tmp_root}" "json-required"
	# Verify keyword-detector creates ultrawork-state.json
	if [[ -f "${tmp_root}/.omca/state/ultrawork-state.json" ]]; then
		if jq -e '.status == "active"' "${tmp_root}/.omca/state/ultrawork-state.json" >/dev/null 2>&1; then
			pass "keyword-detector creates ultrawork-state.json with active status"
		else
			fail "keyword-detector created ultrawork-state.json but status is not active"
		fi
	else
		fail "keyword-detector should create ultrawork-state.json on ultrawork keyword"
	fi

	# Stop: ralph-persistence allows stop when no state files (clean state after keyword tests)
	rm -f "${tmp_root}/.omca/state/ralph-state.json" "${tmp_root}/.omca/state/ultrawork-state.json"
	local stop_payload="${HOOK_FIXTURES_DIR}/stop-basic.json"
	run_registered_hooks "Stop default (no state)" "Stop" "" "${stop_payload}" "${tmp_root}" "empty"

	# Stop: ralph-persistence blocks stop when ralph state exists
	printf '{"status":"active","tasks":[{"id":"1","status":"pending"}],"last_task_hash":"","stagnation_count":0}\n' \
		>"${tmp_root}/.omca/state/ralph-state.json"
	run_registered_hooks "Stop with ralph active" "Stop" "" "${stop_payload}" "${tmp_root}" "json-required"
	rm -f "${tmp_root}/.omca/state/ralph-state.json"

	# SubagentStart / SubagentStop
	local subagentstart_payload="${HOOK_FIXTURES_DIR}/subagentstart-basic.json"
	local subagentstopcomplete_payload="${HOOK_FIXTURES_DIR}/subagentstopcomplete-basic.json"

	run_registered_hooks "SubagentStart basic" "SubagentStart" "" "${subagentstart_payload}" "${tmp_root}" "json-required"
	run_registered_hooks "SubagentStop basic" "SubagentStop" "" "${subagentstopcomplete_payload}" "${tmp_root}" "json-optional"

	# Verify active-agents.json was created by SubagentStart hook
	if [[ -f "${tmp_root}/.omca/state/active-agents.json" ]]; then
		pass "SubagentStart created active-agents.json"
	else
		fail "SubagentStart did not create active-agents.json"
	fi

	if [[ -n "${HOOK_CASE}" ]]; then
		case "${HOOK_CASE}" in
		compaction-race)
			run_compaction_race_case "${session_compact_payload}" "${tmp_root}"
			;;
		*)
			fail "Unsupported hook case '${HOOK_CASE}'. Supported: compaction-race"
			;;
		esac
	fi

	rm -rf "${tmp_root}"
}

check_mcp() {
	log "Running mcp checks"

	validate_json_file "${MCP_JSON}" "mcp registry"
	validate_json_file "${MCP_FIXTURES_DIR}/initialize.json" "mcp fixture initialize"
	validate_json_file "${MCP_FIXTURES_DIR}/initialized-notification.json" "mcp fixture initialized notification"
	validate_json_file "${MCP_FIXTURES_DIR}/tools-list.json" "mcp fixture tools/list"
	validate_json_file "${MCP_FIXTURES_DIR}/expected-tools.json" "mcp fixture expected tools"

	if [[ ! -d "${MCP_SERVER_PROJECT}" ]]; then
		fail "mcp server project directory missing at ${MCP_SERVER_PROJECT}"
		return 1
	fi

	local mcp_tmp
	mcp_tmp="$(mktemp -d)"
	local stdout_file="${mcp_tmp}/stdout.jsonl"
	local stderr_file="${mcp_tmp}/stderr.log"

	{
		cat "${MCP_FIXTURES_DIR}/initialize.json" || true
		printf '\n'
		cat "${MCP_FIXTURES_DIR}/initialized-notification.json" || true
		printf '\n'
		cat "${MCP_FIXTURES_DIR}/tools-list.json" || true
		printf '\n'
	} | timeout 45 uv run --project "${MCP_SERVER_PROJECT}" python "${MCP_SERVER_PROJECT}/omca-mcp.py" >"${stdout_file}" 2>"${stderr_file}"
	local mcp_status=$?

	if [[ "${mcp_status}" -ne 0 ]]; then
		local stderr_excerpt
		stderr_excerpt="$(sed -n '1,12p' "${stderr_file}" 2>/dev/null)"
		fail "mcp handshake command exited ${mcp_status}${stderr_excerpt:+ (${stderr_excerpt})}"
		rm -rf "${mcp_tmp}"
		return 1
	fi

	if [[ ! -s "${stdout_file}" ]]; then
		fail "mcp handshake returned empty stdout"
		rm -rf "${mcp_tmp}"
		return 1
	fi

	if ! jq -s . "${stdout_file}" >/dev/null 2>&1; then
		fail "mcp handshake stdout is not valid JSON lines"
		rm -rf "${mcp_tmp}"
		return 1
	fi

	if jq -s -e 'map(select(.id == 1)) | length >= 1' "${stdout_file}" >/dev/null 2>&1; then
		pass "mcp initialize response received"
	else
		fail "mcp initialize response missing"
	fi

	if jq -s -e 'map(select(.id == 2)) | length >= 1' "${stdout_file}" >/dev/null 2>&1; then
		pass "mcp tools/list response received"
	else
		fail "mcp tools/list response missing"
	fi

	local expected_tool
	while IFS= read -r expected_tool; do
		[[ -z "${expected_tool}" ]] && continue
		if jq -s -e --arg tool "${expected_tool}" 'map(select(.id == 2))[0].result.tools | map(.name) | index($tool) != null' "${stdout_file}" >/dev/null 2>&1; then
			pass "mcp tools/list contains ${expected_tool}"
		else
			fail "mcp tools/list missing ${expected_tool}"
		fi
	done < <(jq -r '.[]' "${MCP_FIXTURES_DIR}/expected-tools.json" 2>/dev/null || true)

	rm -rf "${mcp_tmp}"
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--check)
		if [[ -z "$2" ]]; then
			log "Missing value for --check"
			usage
			exit 2
		fi
		case "$2" in
		claims | hooks | mcp)
			CHECKS+=("$2")
			shift 2
			;;
		*)
			log "Unsupported check '$2'"
			usage
			exit 2
			;;
		esac
		;;
	--case)
		if [[ -z "$2" ]]; then
			log "Missing value for --case"
			usage
			exit 2
		fi
		HOOK_CASE="$2"
		shift 2
		;;
	--marketplace)
		if [[ -z "$2" ]]; then
			log "Missing value for --marketplace"
			usage
			exit 2
		fi
		MARKETPLACE_PATH="$2"
		MARKETPLACE_OVERRIDE=1
		shift 2
		;;
	--help)
		usage
		exit 0
		;;
	*)
		log "Unknown argument '$1'"
		usage
		exit 2
		;;
	esac
done

if [[ ${#CHECKS[@]} -eq 0 ]]; then
	CHECKS=("claims" "hooks" "mcp")
fi

if [[ -n "${HOOK_CASE}" ]] && ! contains_check "hooks"; then
	log "--case applies only to hooks checks; include '--check hooks'"
	exit 2
fi

log "Repository root: ${REPO_ROOT}"
log "Requested checks: ${CHECKS[*]}"
if [[ -n "${HOOK_CASE}" ]]; then
	log "Hook case: ${HOOK_CASE}"
fi
if [[ "${MARKETPLACE_OVERRIDE}" -eq 1 ]]; then
	log "Marketplace override: ${MARKETPLACE_PATH}"
fi

for local_check in "${CHECKS[@]}"; do
	case "${local_check}" in
	claims)
		check_claims
		;;
	hooks)
		check_hooks
		;;
	mcp)
		check_mcp
		;;
	*)
		log "Unknown check: ${local_check}"
		;;
	esac
done

log "Summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed, ${SKIP_COUNT} skipped"

if [[ "${FAIL_COUNT}" -ne 0 ]]; then
	exit 1
fi

exit 0
