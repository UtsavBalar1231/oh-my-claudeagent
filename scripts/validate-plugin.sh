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
OMCA_MD="${REPO_ROOT}/OMCA.md"
OMCA_SETUP_SKILL_MD="${REPO_ROOT}/skills/omca-setup/SKILL.md"

AGENTS_DIR="${VALIDATE_PLUGIN_AGENTS_DIR:-${REPO_ROOT}/agents}"
FORCE_HARD_CUTOVER="${VALIDATE_PLUGIN_FORCE_HARD_CUTOVER:-0}"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
WARN_COUNT=0
HARD_CUTOVER_ACTIVE=0

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

warn() {
	WARN_COUNT=$((WARN_COUNT + 1))
	log "WARN: $1"
}

usage() {
	cat <<'USAGE'
Usage: bash scripts/validate-plugin.sh [options]

Options:
  --check <claims|hooks|mcp>   Run a specific check (repeatable)
  --case <name>                Named hook scenario (supports: compaction-race, worktree-output-missing)
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

semver_major() {
	local version="$1"

	if [[ "${version}" =~ ^([0-9]+)\. ]]; then
		printf '%s' "${BASH_REMATCH[1]}"
		return 0
	fi

	return 1
}

set_hard_cutover_mode() {
	local plugin_version="$1"
	local marketplace_version="$2"
	local plugin_major=""
	local marketplace_major=""

	HARD_CUTOVER_ACTIVE=0

	if [[ "${FORCE_HARD_CUTOVER}" == "1" ]]; then
		HARD_CUTOVER_ACTIVE=1
		pass "migration marker: forced hard-cutover mode via VALIDATE_PLUGIN_FORCE_HARD_CUTOVER=1"
		return 0
	fi

	if ! plugin_major="$(semver_major "${plugin_version}")"; then
		fail "migration marker: plugin version '${plugin_version}' is not semver-compatible"
		return 1
	fi

	if ! marketplace_major="$(semver_major "${marketplace_version}")"; then
		fail "migration marker: marketplace version '${marketplace_version}' is not semver-compatible"
		return 1
	fi

	if [[ "${plugin_major}" -ge 2 || "${marketplace_major}" -ge 2 ]]; then
		if [[ "${plugin_major}" -ge 2 && "${marketplace_major}" -ge 2 ]]; then
			HARD_CUTOVER_ACTIVE=1
			pass "migration marker: hard-cutover mode active at plugin=${plugin_version}, marketplace=${marketplace_version}"
		else
			fail "migration marker: plugin/marketplace major versions diverge (${plugin_version} vs ${marketplace_version})"
		fi
	else
		pass "migration marker: pre-2.0.0 mode at plugin=${plugin_version}, marketplace=${marketplace_version}"
	fi

	return 0
}

check_latest_hook_lifecycle_coverage() {
	local latest_lifecycle_events=(
		"ConfigChange"
		"InstructionsLoaded"
		"Notification"
		"PermissionRequest"
		"PostCompact"
		"PostToolUse"
		"PostToolUseFailure"
		"PreCompact"
		"PreToolUse"
		"SessionEnd"
		"SessionStart"
		"Stop"
		"StopFailure"
		"SubagentStart"
		"SubagentStop"
		"TaskCompleted"
		"TeammateIdle"
		"UserPromptSubmit"
	)
	local post_cutover_events=(
		"TaskCreated"
		"CwdChanged"
		"FileChanged"
		"WorktreeCreate"
	)
	local event_name

	for event_name in "${latest_lifecycle_events[@]}"; do
		if jq -e --arg event "${event_name}" '.hooks | has($event)' "${HOOKS_JSON}" >/dev/null 2>&1; then
			pass "latest hook lifecycle coverage includes ${event_name}"
		else
			fail "latest hook lifecycle coverage missing ${event_name}"
		fi
	done

	for event_name in "${post_cutover_events[@]}"; do
		if jq -e --arg event "${event_name}" '.hooks | has($event)' "${HOOKS_JSON}" >/dev/null 2>&1; then
			pass "post-cutover hook lifecycle coverage includes ${event_name}"
		elif [[ "${HARD_CUTOVER_ACTIVE}" -eq 1 ]]; then
			fail "post-cutover hook lifecycle coverage missing ${event_name}"
		else
			skip "post-cutover hook lifecycle marker ${event_name} not required before 2.0.0"
		fi
	done
}

frontmatter_has_key() {
	local file_path="$1"
	local key="$2"
	local in_frontmatter=0
	local frontmatter_seen=0
	local line

	while IFS= read -r line; do
		if [[ "${line}" == "---" ]]; then
			if [[ "${frontmatter_seen}" -eq 0 ]]; then
				frontmatter_seen=1
				in_frontmatter=1
				continue
			fi
			if [[ "${in_frontmatter}" -eq 1 ]]; then
				in_frontmatter=0
				break
			fi
		fi

		if [[ "${in_frontmatter}" -eq 1 ]] && [[ "${line}" =~ ^${key}: ]]; then
			return 0
		fi
	done <"${file_path}"

	return 1
}

collect_frontmatter_key_matches() {
	local key="$1"
	local agent_file

	while IFS= read -r agent_file; do
		[[ -z "${agent_file}" ]] && continue
		if frontmatter_has_key "${agent_file}" "${key}"; then
			printf '%s\n' "${agent_file}"
		fi
	done < <(find "${AGENTS_DIR}" -maxdepth 1 -name "*.md" -print 2>/dev/null)
}

check_agent_frontmatter_hygiene() {
	local agent_count
	agent_count="$(find "${AGENTS_DIR}" -maxdepth 1 -name "*.md" -print 2>/dev/null | wc -l | tr -d ' ')"
	if [[ "${agent_count}" -eq 0 ]]; then
		fail "agent frontmatter hygiene: no agent files found in ${AGENTS_DIR}"
		return 1
	fi

	local tools_matches=()
	mapfile -t tools_matches < <(collect_frontmatter_key_matches "tools")
	if [[ "${#tools_matches[@]}" -eq 0 ]]; then
		pass "agent frontmatter hygiene: no top-level tools allowlists detected"
	else
		local allowed_tools_exception="${REPO_ROOT}/agents/multimodal-looker.md"
		local unexpected_tools=()
		local tools_file
		for tools_file in "${tools_matches[@]}"; do
			if [[ "${tools_file}" != "${allowed_tools_exception}" ]]; then
				unexpected_tools+=("${tools_file}")
			fi
		done

		if [[ "${#unexpected_tools[@]}" -eq 0 ]] && [[ "${#tools_matches[@]}" -eq 1 ]] &&
			grep -Fq "repository's only top-level" "${allowed_tools_exception}"; then
			pass "agent frontmatter hygiene: only documented multimodal-looker tools allowlist remains"
		elif [[ "${HARD_CUTOVER_ACTIVE}" -eq 1 ]]; then
			fail "agent frontmatter hygiene: top-level tools allowlists are forbidden after 2.0.0 marker (${unexpected_tools[*]:-${tools_matches[*]}})"
		else
			skip "agent frontmatter hygiene: top-level tools allowlists still present pre-2.0.0 (${unexpected_tools[*]:-${tools_matches[*]}})"
		fi
	fi

	local permission_matches=()
	mapfile -t permission_matches < <(collect_frontmatter_key_matches "permissionMode")
	if [[ "${#permission_matches[@]}" -eq 0 ]]; then
		pass "agent frontmatter hygiene: no legacy permissionMode holdouts detected"
	elif [[ "${HARD_CUTOVER_ACTIVE}" -eq 1 ]]; then
		fail "agent frontmatter hygiene: legacy permissionMode holdouts are forbidden after 2.0.0 marker (${permission_matches[*]})"
	else
		skip "agent frontmatter hygiene: legacy permissionMode holdouts still present pre-2.0.0 (${permission_matches[*]})"
	fi
}

relative_path() {
	local path="$1"
	if [[ "${path}" == "${REPO_ROOT}/"* ]]; then
		printf '%s' "${path:${#REPO_ROOT}+1}"
	else
		printf '%s' "${path}"
	fi
}

check_policy_marker_in_file() {
	local file_path="$1"
	local marker="$2"
	local label="$3"
	local rel_path

	if [[ ! -f "${file_path}" ]]; then
		fail "policy posture: missing file ${file_path}"
		return 1
	fi

	rel_path="$(relative_path "${file_path}")"
	if grep -Fq "${marker}" "${file_path}"; then
		pass "policy posture: ${rel_path} includes ${label} marker"
	else
		fail "policy posture: ${rel_path} missing ${label} marker (${marker})"
	fi
}

check_policy_phrase_in_file() {
	local file_path="$1"
	local regex="$2"
	local label="$3"
	local rel_path

	if [[ ! -f "${file_path}" ]]; then
		fail "policy posture: missing file ${file_path}"
		return 1
	fi

	rel_path="$(relative_path "${file_path}")"
	if grep -Eiq "${regex}" "${file_path}"; then
		pass "policy posture: ${rel_path} includes ${label} guidance"
	else
		fail "policy posture: ${rel_path} missing ${label} guidance"
	fi
}

check_policy_posture_alignment() {
	# Policy posture markers live in OMCA.md and the omca-setup skill.
	# templates/claudemd.md is the session-injected runtime prompt — it
	# intentionally omits managed-settings trivia, so it is NOT enforced here.
	local policy_docs=(
		"${OMCA_MD}"
		"${OMCA_SETUP_SKILL_MD}"
	)
	local doc_path

	for doc_path in "${policy_docs[@]}"; do
		check_policy_marker_in_file "${doc_path}" 'teammateMode: "auto"' 'auto mode'
		check_policy_marker_in_file "${doc_path}" 'allowManagedPermissionRulesOnly' 'managed settings boundary'
		check_policy_marker_in_file "${doc_path}" 'sandbox.failIfUnavailable' 'sandbox fail-closed'
		check_policy_phrase_in_file "${doc_path}" 'does not auto-allow|never auto-allow|no auto-allow' 'non-bypassing permission filter'
	done
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
	worktree-path)
		if [[ ! -s "${stdout_file}" ]]; then
			fail "${label}: expected worktree path output but received empty stdout"
			rm -rf "${run_dir}"
			return 1
		fi

		local worktree_path
		worktree_path="$(sed -n '1p' "${stdout_file}" | tr -d '\r')"
		local extra_output
		extra_output="$(sed -n '2,$p' "${stdout_file}" | tr -d '\r')"
		if [[ -z "${worktree_path}" ]] || [[ -n "${extra_output}" ]]; then
			fail "${label}: worktree output must be exactly one absolute path"
			rm -rf "${run_dir}"
			return 1
		fi

		if [[ "${worktree_path}" != /* ]]; then
			fail "${label}: worktree path is not absolute (${worktree_path})"
			rm -rf "${run_dir}"
			return 1
		fi

		if [[ ! -d "${worktree_path}" ]]; then
			fail "${label}: worktree path does not exist (${worktree_path})"
			rm -rf "${run_dir}"
			return 1
		fi

		local worktree_name
		worktree_name="$(jq -r '.name // ""' "${payload_path}" 2>/dev/null)"
		local tracking_file="${project_root}/.omca/state/worktrees/${worktree_name}.json"
		if [[ ! -f "${tracking_file}" ]]; then
			fail "${label}: missing structured worktree tracking file (${tracking_file})"
			rm -rf "${run_dir}"
			return 1
		fi

		if jq -e --arg worktree_path "${worktree_path}" '.worktreePath == $worktree_path' "${tracking_file}" >/dev/null 2>&1; then
			pass "${label}: script returned tracked absolute worktree path"
		else
			fail "${label}: structured tracking file missing matching worktreePath"
			rm -rf "${run_dir}"
			return 1
		fi
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

check_skill_description_lengths() {
	local skill_file
	local max_len=250
	local found_any=0

	while IFS= read -r skill_file; do
		[[ -z "${skill_file}" ]] && continue
		found_any=1

		# Extract description from YAML frontmatter, including continuation lines
		# A continuation line starts with whitespace (indented) or is a plain value on the same key line
		local desc=""
		local in_frontmatter=0
		local frontmatter_seen=0
		local capturing=0
		local line

		while IFS= read -r line; do
			if [[ "${line}" == "---" ]]; then
				if [[ "${frontmatter_seen}" -eq 0 ]]; then
					frontmatter_seen=1
					in_frontmatter=1
					continue
				fi
				if [[ "${in_frontmatter}" -eq 1 ]]; then
					break
				fi
			fi

			if [[ "${in_frontmatter}" -eq 0 ]]; then
				continue
			fi

			if [[ "${capturing}" -eq 1 ]]; then
				# Continuation line: starts with whitespace
				if [[ "${line}" =~ ^[[:space:]]+ ]]; then
					local cont_value
					cont_value="${line#"${line%%[! ]*}"}"
					desc="${desc} ${cont_value}"
					continue
				else
					capturing=0
				fi
			fi

			if [[ "${line}" =~ ^description:[[:space:]]*(.*) ]]; then
				desc="${BASH_REMATCH[1]}"
				capturing=1
			fi
		done <"${skill_file}"

		local skill_name
		skill_name="$(basename "$(dirname "${skill_file}")")"

		if [[ -z "${desc}" ]]; then
			pass "skill description length: ${skill_name} has description field"
			continue
		fi

		local desc_len="${#desc}"
		if [[ "${desc_len}" -gt "${max_len}" ]]; then
			warn "skill description length: ${skill_name} description is ${desc_len} chars (limit ${max_len}) — Claude Code v2.1.84+ may truncate it"
		else
			pass "skill description length: ${skill_name} description is ${desc_len} chars (within ${max_len} limit)"
		fi
	done < <(find "${REPO_ROOT}/skills" -name "SKILL.md" -print 2>/dev/null | sort)

	if [[ "${found_any}" -eq 0 ]]; then
		skip "skill description length: no SKILL.md files found under skills/"
	fi
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

	# Verify agent-metadata.json was removed (OMCA-internal fields removed in v2.0.0)
	if [[ ! -f "${REPO_ROOT}/servers/agent-metadata.json" ]]; then
		pass "agent-metadata.json removed (OMCA-internal metadata fields deprecated)"
	else
		fail "agent-metadata.json still exists (should have been removed with costTier/category fields)"
	fi

	# Validate version consistency: plugin.json must match marketplace.json
	local plugin_version marketplace_version
	plugin_version=$(jq -r '.version // ""' "${PLUGIN_JSON}" 2>/dev/null)
	marketplace_version=$(jq -r '.plugins[0].version // ""' "${MARKETPLACE_PATH}" 2>/dev/null)
	if [[ -z "${plugin_version}" ]]; then
		fail "version consistency: plugin.json has no version field"
	elif [[ -z "${marketplace_version}" ]]; then
		fail "version consistency: marketplace.json has no plugins[0].version field"
	elif [[ "${plugin_version}" == "${marketplace_version}" ]]; then
		pass "version consistency: plugin.json and marketplace.json both at ${plugin_version}"
	else
		fail "version consistency: plugin.json=${plugin_version} does not match marketplace.json=${marketplace_version}"
	fi

	set_hard_cutover_mode "${plugin_version}" "${marketplace_version}"
	check_latest_hook_lifecycle_coverage
	check_agent_frontmatter_hygiene
	check_skill_description_lengths
	check_policy_posture_alignment
}

check_hook_fixtures_exist() {
	local fixtures=(
		"pretooluse-task-agent.json"
		"pretooluse-write.json"
		"permissionrequest-bash.json"
		"permissionrequest-exitplanmode.json"
		"sessionstart-compact.json"
		"instructionsloaded-basic.json"
		"taskcreated-basic.json"
		"taskcompleted-basic.json"
		"taskcompleted-with-evidence.json"
		"taskcompleted-with-edits-no-evidence.json"
		"teammateidle-basic.json"
		"cwdchanged-basic.json"
		"filechanged-basic.json"
		"worktreecreate-basic.json"
		"userpromptsubmit-ralph.json"
		"userpromptsubmit-ultrawork.json"
		"stop-basic.json"
		"subagentstart-basic.json"
		"subagentstopcomplete-basic.json"
		"stopfailure-ratelimit.json"
		"posttoolusefailure-bash.json"
		"posttoolusefailure-read.json"
	)

	local file_name
	for file_name in "${fixtures[@]}"; do
		validate_json_file "${HOOK_FIXTURES_DIR}/${file_name}" "hook fixture ${file_name}"
	done
}

prepare_hook_fixture_repo() {
	local repo_root="$1"

	mkdir -p "${repo_root}/.claude" "${repo_root}/.claude-plugin" "${repo_root}/hooks"
	touch \
		"${repo_root}/.claude/settings.json" \
		"${repo_root}/.mcp.json" \
		"${repo_root}/AGENTS.md" \
		"${repo_root}/CLAUDE.md" \
		"${repo_root}/hooks/hooks.json" \
		"${repo_root}/.claude-plugin/plugin.json" \
		"${repo_root}/settings.json"

	git -C "${repo_root}" init -q >/dev/null 2>&1 || {
		fail "hook fixture repo setup: git init failed for ${repo_root}"
		return 1
	}

	printf 'fixture repo\n' >"${repo_root}/fixture.txt"
	git -C "${repo_root}" add fixture.txt >/dev/null 2>&1 || {
		fail "hook fixture repo setup: git add failed for ${repo_root}"
		return 1
	}

	GIT_AUTHOR_NAME="OMCA Fixture" \
		GIT_AUTHOR_EMAIL="fixture@example.com" \
		GIT_COMMITTER_NAME="OMCA Fixture" \
		GIT_COMMITTER_EMAIL="fixture@example.com" \
		git -C "${repo_root}" commit -q -m "fixture" >/dev/null 2>&1 || {
		fail "hook fixture repo setup: git commit failed for ${repo_root}"
		return 1
	}

	pass "hook fixture repo setup: initialized git repo at ${repo_root}"
	return 0
}

check_repo_state_file() {
	local state_file="$1"
	local repo_root="$2"
	local event_name="$3"
	local changed_path="${4:-}"

	if [[ ! -f "${state_file}" ]]; then
		fail "repo-state check: missing ${state_file} after ${event_name}"
		return 1
	fi

	if jq -e \
		--arg root "${repo_root}" \
		--arg event_name "${event_name}" \
		--arg changed_path "${changed_path}" '
			.repoRoot == $root
			and .lastEvent == $event_name
			and .watchPaths == [
				$root + "/.claude/settings.json",
				$root + "/.mcp.json",
				$root + "/AGENTS.md",
				$root + "/CLAUDE.md",
				$root + "/hooks/hooks.json",
				$root + "/.claude-plugin/plugin.json",
				$root + "/settings.json"
			]
			and (if $changed_path == "" then (.changedFile | not) else .changedFile.path == $changed_path end)
		' "${state_file}" >/dev/null 2>&1; then
		pass "repo-state check: ${event_name} stored expected repo root and watchPaths"
	else
		fail "repo-state check: ${event_name} state missing expected watchPaths or metadata"
	fi
}

run_worktree_output_missing_case() {
	local payload_path="$1"
	local project_root="$2"
	local fake_script

	fake_script="$(mktemp)"
	printf '#!/bin/bash\nexit 0\n' >"${fake_script}"
	chmod +x "${fake_script}"

	run_script_with_payload "WorktreeCreate missing output case" "${fake_script}" "${payload_path}" "${project_root}" "worktree-path"

	rm -f "${fake_script}"
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
	prepare_hook_fixture_repo "${tmp_root}"

	local pretool_task_payload="${HOOK_FIXTURES_DIR}/pretooluse-task-agent.json"
	local pretool_write_payload="${tmp_root}/pretooluse-write.runtime.json"
	local permission_payload="${HOOK_FIXTURES_DIR}/permissionrequest-bash.json"
	local exitplanmode_payload="${HOOK_FIXTURES_DIR}/permissionrequest-exitplanmode.json"
	local session_compact_payload="${HOOK_FIXTURES_DIR}/sessionstart-compact.json"
	local instructions_payload="${HOOK_FIXTURES_DIR}/instructionsloaded-basic.json"
	local taskcreated_payload="${tmp_root}/taskcreated-basic.runtime.json"
	local task_payload="${HOOK_FIXTURES_DIR}/taskcompleted-basic.json"
	local teammate_payload="${HOOK_FIXTURES_DIR}/teammateidle-basic.json"
	local cwdchanged_payload="${tmp_root}/cwdchanged-basic.runtime.json"
	local filechanged_payload="${tmp_root}/filechanged-basic.runtime.json"
	local worktree_payload="${tmp_root}/worktreecreate-basic.runtime.json"
	local filechanged_matcher='.mcp.json|AGENTS.md|CLAUDE.md|hooks.json|plugin.json|settings.json|pyproject.toml|justfile'

	local existing_file="${tmp_root}/existing.txt"
	touch "${existing_file}"
	jq --arg file "${existing_file}" '.tool_input.file_path = $file' "${HOOK_FIXTURES_DIR}/pretooluse-write.json" >"${pretool_write_payload}"
	jq --arg cwd "${tmp_root}" '.cwd = $cwd' "${HOOK_FIXTURES_DIR}/taskcreated-basic.json" >"${taskcreated_payload}"
	jq --arg cwd "${tmp_root}/hooks" --arg old_cwd "${tmp_root}" --arg new_cwd "${tmp_root}/hooks" '.cwd = $cwd | .old_cwd = $old_cwd | .new_cwd = $new_cwd' "${HOOK_FIXTURES_DIR}/cwdchanged-basic.json" >"${cwdchanged_payload}"
	jq --arg cwd "${tmp_root}" --arg file_path "${tmp_root}/.claude/settings.json" '.cwd = $cwd | .file_path = $file_path' "${HOOK_FIXTURES_DIR}/filechanged-basic.json" >"${filechanged_payload}"
	jq --arg cwd "${tmp_root}" '.cwd = $cwd' "${HOOK_FIXTURES_DIR}/worktreecreate-basic.json" >"${worktree_payload}"

	run_registered_hooks "PreToolUse Task|Agent" "PreToolUse" "Task|Agent" "${pretool_task_payload}" "${tmp_root}" "json-required"
	run_registered_hooks "PreToolUse Write" "PreToolUse" "Write" "${pretool_write_payload}" "${tmp_root}" "json-required"
	run_registered_hooks "PermissionRequest Bash" "PermissionRequest" "Bash" "${permission_payload}" "${tmp_root}" "json-required"
	run_registered_hooks "PermissionRequest ExitPlanMode" "PermissionRequest" "ExitPlanMode" "${exitplanmode_payload}" "${tmp_root}" "json-required"

	printf 'compact fixture context' >"${tmp_root}/.omca/state/compaction-context.md"
	run_registered_hooks "SessionStart compact" "SessionStart" "compact" "${session_compact_payload}" "${tmp_root}" "json-required"

	run_registered_hooks "TaskCreated default" "TaskCreated" "" "${taskcreated_payload}" "${tmp_root}" "empty"
	if [[ -f "${tmp_root}/.omca/logs/tasks.jsonl" ]]; then
		if jq -e '.event == "task_created"' "${tmp_root}/.omca/logs/tasks.jsonl" >/dev/null 2>&1; then
			pass "TaskCreated hook logged task_created event to tasks.jsonl"
		else
			fail "TaskCreated hook created tasks.jsonl but missing task_created event"
		fi
	else
		fail "TaskCreated hook did not create tasks.jsonl"
	fi

	run_registered_hooks "TaskCompleted default" "TaskCompleted" "" "${task_payload}" "${tmp_root}" "empty"
	run_registered_hooks "TeammateIdle default" "TeammateIdle" "" "${teammate_payload}" "${tmp_root}" "empty"

	run_registered_hooks "InstructionsLoaded default" "InstructionsLoaded" "" "${instructions_payload}" "${tmp_root}" "json-optional"
	run_registered_hooks "CwdChanged default" "CwdChanged" "" "${cwdchanged_payload}" "${tmp_root}" "json-required"
	check_repo_state_file "${tmp_root}/.omca/state/repo-state.json" "${tmp_root}" "CwdChanged"

	run_registered_hooks "FileChanged watchPaths" "FileChanged" "${filechanged_matcher}" "${filechanged_payload}" "${tmp_root}" "json-required"
	check_repo_state_file "${tmp_root}/.omca/state/repo-state.json" "${tmp_root}" "FileChanged" "${tmp_root}/.claude/settings.json"

	run_registered_hooks "WorktreeCreate default" "WorktreeCreate" "" "${worktree_payload}" "${tmp_root}" "worktree-path"

	# UserPromptSubmit: keyword-detector should produce JSON with additionalContext
	local ralph_payload="${HOOK_FIXTURES_DIR}/userpromptsubmit-ralph.json"
	local ultrawork_payload="${HOOK_FIXTURES_DIR}/userpromptsubmit-ultrawork.json"
	local userpromptsubmit_commands
	local state_suffix="-state.json"
	local ralph_wrapper_state="${tmp_root}/.omca/state/ralph${state_suffix}"
	local ultrawork_wrapper_state="${tmp_root}/.omca/state/ultrawork${state_suffix}"
	userpromptsubmit_commands="$(resolve_hook_commands "UserPromptSubmit" "")"
	if [[ -n "${userpromptsubmit_commands}" ]]; then
		run_registered_hooks "UserPromptSubmit ralph" "UserPromptSubmit" "" "${ralph_payload}" "${tmp_root}" "json-required"
		if [[ -f "${ralph_wrapper_state}" ]]; then
			if jq -e '.status == "active"' "${ralph_wrapper_state}" >/dev/null 2>&1; then
				pass "keyword-detector creates Ralph wrapper state with active status"
			else
				fail "keyword-detector created Ralph wrapper state but status is not active"
			fi
		else
			fail "keyword-detector should create Ralph wrapper state on ralph keyword"
		fi

		run_registered_hooks "UserPromptSubmit ultrawork" "UserPromptSubmit" "" "${ultrawork_payload}" "${tmp_root}" "json-required"
		if [[ -f "${ultrawork_wrapper_state}" ]]; then
			if jq -e '.status == "active"' "${ultrawork_wrapper_state}" >/dev/null 2>&1; then
				pass "keyword-detector creates ultrawork wrapper state with active status"
			else
				fail "keyword-detector created ultrawork wrapper state but status is not active"
			fi
		else
			fail "keyword-detector should create ultrawork wrapper state on ultrawork keyword"
		fi
	else
		skip "UserPromptSubmit keyword-detector validations: no matching hook command registered"
	fi

	rm -f "${ralph_wrapper_state}" "${ultrawork_wrapper_state}"
	local stop_payload="${HOOK_FIXTURES_DIR}/stop-basic.json"
	run_registered_hooks "Stop default (no state)" "Stop" "" "${stop_payload}" "${tmp_root}" "empty"

	printf '{"status":"active","activatedAt":"2026-03-22T12:00:00Z","tasks":[{"id":"t1","status":"in_progress"}],"last_task_hash":"","stagnation_count":0}\n' \
		>"${ralph_wrapper_state}"
	run_registered_hooks "Stop with ralph active" "Stop" "" "${stop_payload}" "${tmp_root}" "json-required"
	rm -f "${ralph_wrapper_state}"

	local uw_epoch
	uw_epoch=$(date +%s)
	printf '{"status":"active","activatedAt":"2026-03-22T12:00:00Z","wrapper":"stop-hook","mode":"ultrawork"}\n' \
		>"${ultrawork_wrapper_state}"
	printf '{"active":[{"id":"test-agent-1","type":"explore","status":"running","startedAt":"2026-03-22T12:00:00Z","started_epoch":%s}],"completed":[]}\n' \
		"${uw_epoch}" >"${tmp_root}/.omca/state/subagents.json"
	run_registered_hooks "Stop ultrawork active + running agents (allow)" "Stop" "" "${stop_payload}" "${tmp_root}" "empty"
	rm -f "${ultrawork_wrapper_state}" "${tmp_root}/.omca/state/subagents.json"

	printf '{"status":"active","activatedAt":"2026-03-22T12:00:00Z","wrapper":"stop-hook","mode":"ultrawork"}\n' \
		>"${ultrawork_wrapper_state}"
	printf '{"active":[],"completed":[]}\n' \
		>"${tmp_root}/.omca/state/subagents.json"
	run_registered_hooks "Stop ultrawork active + no agents (block)" "Stop" "" "${stop_payload}" "${tmp_root}" "json-required"
	rm -f "${ultrawork_wrapper_state}" "${tmp_root}/.omca/state/subagents.json"

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

	# StopFailure: handler logs to stop-failures.jsonl and exits 0 (no stdout)
	local stopfailure_payload="${HOOK_FIXTURES_DIR}/stopfailure-ratelimit.json"
	run_registered_hooks "StopFailure rate_limit" "StopFailure" "" "${stopfailure_payload}" "${tmp_root}" "empty"
	if [[ -f "${tmp_root}/.omca/logs/stop-failures.jsonl" ]]; then
		if jq -e '.event == "stop_failure"' "${tmp_root}/.omca/logs/stop-failures.jsonl" >/dev/null 2>&1; then
			pass "StopFailure handler logged stop_failure event to stop-failures.jsonl"
		else
			fail "StopFailure handler created stop-failures.jsonl but missing stop_failure event"
		fi
	else
		fail "StopFailure handler did not create stop-failures.jsonl"
	fi

	if [[ -n "${HOOK_CASE}" ]]; then
		case "${HOOK_CASE}" in
		compaction-race)
			run_compaction_race_case "${session_compact_payload}" "${tmp_root}"
			;;
		worktree-output-missing)
			run_worktree_output_missing_case "${worktree_payload}" "${tmp_root}"
			;;
		*)
			fail "Unsupported hook case '${HOOK_CASE}'. Supported: compaction-race, worktree-output-missing"
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

log "Summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed, ${SKIP_COUNT} skipped, ${WARN_COUNT} warned"

if [[ "${FAIL_COUNT}" -ne 0 ]]; then
	exit 1
fi

exit 0
