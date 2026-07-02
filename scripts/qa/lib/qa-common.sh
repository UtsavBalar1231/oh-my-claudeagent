#!/bin/bash
# scripts/qa/lib/qa-common.sh — shared helpers for the claude-code-qa harness.
#
# Standalone dev-tool library (like scripts/validate-plugin.sh), NOT a hook script:
# no HOOK_INPUT/HOOK_STATE_DIR machinery, no ADR-009 obligations. Source this file,
# do not execute it, except via --self-test below.
#
# Isolation model (binding, see the plan's "Isolation model" section): real $HOME is
# preserved. Every probe that launches `claude` runs against a scratch git project
# (mktemp -d) loading the PACKAGED plugin via --plugin-dir, never the dev checkout.
# A drift-watch pair guards the real, shared state files that a session could mutate:
# whole-file shasum of ~/.claude/settings.json, and a sensitive-key-extraction shasum
# of ~/.claude.json (oauthAccount only — the rest of that file mutates on every
# invocation with counters/timestamps, so whole-file hashing would false-abort).

QA_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QA_ROOT="$(cd "${QA_LIB_DIR}/../../.." && pwd)"

QA_REAL_HOME="${HOME}"
QA_SETTINGS_JSON="${QA_REAL_HOME}/.claude/settings.json"
QA_CLAUDE_JSON="${QA_REAL_HOME}/.claude.json"

declare -a QA_CLEANUP_DIRS=()
QA_DRIFT_CAPTURED=0
QA_SETTINGS_SHA=""
QA_CLAUDEJSON_SHA=""
QA_DRIFTED=0

QA_PASS_COUNT=0
QA_FAIL_COUNT=0
QA_SKIP_COUNT=0

qa_log() { printf '[qa] %s\n' "$1"; }
qa_pass() {
	QA_PASS_COUNT=$((QA_PASS_COUNT + 1))
	qa_log "PASS: $1"
}
qa_fail() {
	QA_FAIL_COUNT=$((QA_FAIL_COUNT + 1))
	qa_log "FAIL: $1"
}
qa_skip() {
	QA_SKIP_COUNT=$((QA_SKIP_COUNT + 1))
	qa_log "SKIP: $1"
}

# qa_assert <0-or-1> <pass-message> <fail-message> — avoids the `cond && pass || fail`
# idiom, where fail would also run if pass itself failed.
qa_assert() {
	if [[ "$1" -eq 0 ]]; then
		qa_pass "$2"
	else
		qa_fail "$3"
	fi
}

# ---- scratch-project factory ----

# Create a throwaway git repo under mktemp -d, registered for teardown. Prints its path.
qa_new_scratch_project() {
	local dir
	dir="$(mktemp -d "${TMPDIR:-/tmp}/qa-scratch-XXXXXX")"
	git -C "${dir}" init -q
	git -C "${dir}" config user.email "qa@example.invalid"
	git -C "${dir}" config user.name "qa harness"
	QA_CLEANUP_DIRS+=("${dir}")
	printf '%s\n' "${dir}"
}

# ---- packaged-plugin build ----

# Build the packaged plugin tree once and cache it in QA_PACKAGE_DIR for the lifetime
# of the calling process. `just qa` exports QA_PACKAGE_DIR before running the chain so
# all five scripts share one build; a standalone --self-test run builds its own.
qa_build_package() {
	if [[ -n "${QA_PACKAGE_DIR:-}" && -d "${QA_PACKAGE_DIR}" ]]; then
		printf '%s\n' "${QA_PACKAGE_DIR}"
		return 0
	fi
	local dir
	dir="$(mktemp -d "${TMPDIR:-/tmp}/qa-package-XXXXXX")"
	bash "${QA_ROOT}/scripts/package-plugin.sh" "${dir}" >/dev/null
	QA_PACKAGE_DIR="${dir}"
	export QA_PACKAGE_DIR
	QA_CLEANUP_DIRS+=("${dir}")
	printf '%s\n' "${dir}"
}

# ---- drift watch ----

_qa_settings_sha() {
	if [[ -f "${QA_SETTINGS_JSON}" ]]; then
		sha256sum "${QA_SETTINGS_JSON}" | awk '{print $1}'
	else
		echo "absent"
	fi
}

_qa_claudejson_sha() {
	if [[ -f "${QA_CLAUDE_JSON}" ]]; then
		jq -cS '.oauthAccount // null' "${QA_CLAUDE_JSON}" 2>/dev/null | sha256sum | awk '{print $1}'
	else
		echo "absent"
	fi
}

# Capture the baseline hashes. MUST run before the first `claude` invocation.
qa_drift_capture() {
	QA_SETTINGS_SHA="$(_qa_settings_sha)"
	QA_CLAUDEJSON_SHA="$(_qa_claudejson_sha)"
	QA_DRIFT_CAPTURED=1
}

# Re-hash and compare to the baseline. Side-effect-free: sets QA_DRIFTED, does not exit.
# Callers (typically the exit trap) decide what to do with the result.
qa_drift_check() {
	if [[ "${QA_DRIFT_CAPTURED}" -ne 1 ]]; then
		qa_log "WARN: drift check ran without a captured baseline (qa_drift_capture never called)"
		return 0
	fi
	local settings_now claudejson_now
	settings_now="$(_qa_settings_sha)"
	claudejson_now="$(_qa_claudejson_sha)"
	if [[ "${settings_now}" != "${QA_SETTINGS_SHA}" ]]; then
		QA_DRIFTED=1
		qa_log "ABORT-DRIFT: ${QA_SETTINGS_JSON} changed during this run (${QA_SETTINGS_SHA} -> ${settings_now})"
	fi
	if [[ "${claudejson_now}" != "${QA_CLAUDEJSON_SHA}" ]]; then
		QA_DRIFTED=1
		qa_log "ABORT-DRIFT: ${QA_CLAUDE_JSON} oauthAccount key changed during this run (${QA_CLAUDEJSON_SHA} -> ${claudejson_now})"
	fi
	return "${QA_DRIFTED}"
}

# ---- hardcoded-path audit ----

# Side-effect-free: greps the packaged tree for literal "~/.claude" outside prose docs.
# Prints matching lines to stdout; caller decides pass/fail. A hardcoded literal here
# would break for any user whose home directory isn't the one that built the package.
qa_check_hardcoded_home_paths() {
	local package_dir="$1"
	# shellcheck disable=SC2088 # literal grep pattern, not a path to expand
	grep -rn '~/\.claude' \
		--include='*.sh' --include='*.json' --include='*.py' \
		"${package_dir}/scripts" "${package_dir}/hooks" "${package_dir}/servers" "${package_dir}/statusline" \
		2>/dev/null | grep -v -E ':[0-9]+:[[:space:]]*#' || true
}

# ---- teardown with receipts ----

# Registered via `trap qa_teardown EXIT`. Runs the drift check, prints a receipt of
# every directory removed, and notes the one class of expected-but-unlisted side
# effect (new ~/.claude/projects/ transcripts from any `claude` invocation in this run).
qa_teardown() {
	local exit_code=$?
	if [[ "${QA_DRIFT_CAPTURED}" -eq 1 ]]; then
		qa_drift_check || true
	fi

	qa_log "--- teardown receipts ---"
	if [[ "${#QA_CLEANUP_DIRS[@]}" -gt 0 ]]; then
		local dir
		for dir in "${QA_CLEANUP_DIRS[@]}"; do
			if [[ "${QA_KEEP_SCRATCH:-0}" == "1" ]]; then
				qa_log "kept (QA_KEEP_SCRATCH=1): ${dir}"
			else
				rm -rf "${dir}"
				qa_log "removed: ${dir}"
			fi
		done
	else
		qa_log "no scratch directories registered"
	fi
	qa_log "expected side effect (not drift): any claude invocation in this run added new transcript files under ~/.claude/projects/"

	if [[ "${QA_DRIFTED}" -eq 1 ]]; then
		qa_log "ABORT-DRIFT reported above — treat as a hard failure regardless of test outcome"
		exit 1
	fi
	exit "${exit_code}"
}

# ---- self-test ----

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	echo "[qa-common --self-test] scratch-project factory"
	proj="$(qa_new_scratch_project)"
	result=0; [[ -d "${proj}/.git" ]] || result=1
	qa_assert "${result}" "scratch project has a git repo" "scratch project missing .git"

	echo "[qa-common --self-test] packaged-plugin build"
	pkg="$(qa_build_package)"
	result=0; [[ -f "${pkg}/.claude-plugin/plugin.json" ]] || result=1
	qa_assert "${result}" "package build produced plugin.json" "package build missing plugin.json"
	result=0; [[ ! -d "${pkg}/scripts/qa" ]] || result=1
	qa_assert "${result}" "packaged tree excludes scripts/qa/" "packaged tree shipped scripts/qa/"

	echo "[qa-common --self-test] drift watch (no real state touched)"
	qa_drift_capture
	qa_drift_check
	result=0; [[ "${QA_DRIFTED}" -eq 0 ]] || result=1
	qa_assert "${result}" "drift check clean when nothing changed" "drift check false-positived with no changes"

	echo "[qa-common --self-test] hardcoded-path audit on a seeded violation"
	seed_dir="$(mktemp -d "${TMPDIR:-/tmp}/qa-selftest-seed-XXXXXX")"
	mkdir -p "${seed_dir}/scripts"
	printf '#!/bin/bash\ncat ~/.claude/settings.json\n' >"${seed_dir}/scripts/bad.sh"
	hits="$(qa_check_hardcoded_home_paths "${seed_dir}")"
	result=0; [[ -n "${hits}" ]] || result=1
	qa_assert "${result}" "hardcoded-path audit caught the seeded violation" "hardcoded-path audit missed the seeded violation"
	clean_hits="$(qa_check_hardcoded_home_paths "${pkg}")"
	result=0; [[ -z "${clean_hits}" ]] || result=1
	qa_assert "${result}" "packaged tree has no hardcoded ~/.claude literals" "packaged tree contains hardcoded ~/.claude literals: ${clean_hits}"
	rm -rf "${seed_dir}"

	qa_log "self-test: ${QA_PASS_COUNT} passed, ${QA_FAIL_COUNT} failed"
	trap qa_teardown EXIT
	[[ "${QA_FAIL_COUNT}" -eq 0 ]]
fi
