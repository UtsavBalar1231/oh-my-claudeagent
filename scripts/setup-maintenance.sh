#!/usr/bin/env bash
# Setup hook. Registered twice in hooks/hooks.json, once per matcher, and branches
# on the payload's `trigger` field ("init" | "maintenance") to pick its half:
#   init        -- read-only dependency report; never installs or mutates anything.
#   maintenance -- runs the existing housekeeping sweeps.
# Setup fires only on `claude --init-only`, `-p --init`, and `-p --maintenance`,
# so this is the non-interactive provisioning path, not the per-session one.
source "$(dirname "$0")/lib/common.sh"

hook_is_disabled "setup-maintenance" && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Sourcing common.sh drains stdin, so a child script that does the same would wait
# out its own stdin timeout. Every child call below reads from /dev/null instead.
run_child() {
	bash "${SCRIPT_DIR}/$1" </dev/null 2>&1
}

report_dependency() {
	local name="$1" tier="$2" version
	if ! command -v "${name}" >/dev/null 2>&1; then
		printf '%s: MISSING (%s)\n' "${name}" "${tier}"
		return 0
	fi
	version=$("${name}" --version 2>&1 | head -1)
	printf '%s: ok (%s)\n' "${name}" "${version}"
}

# ast-grep ships under two binary names; either one satisfies the structural-search
# MCP tools, so the pair is reported as a single dependency.
report_ast_grep() {
	local name
	for name in ast-grep sg; do
		if command -v "${name}" >/dev/null 2>&1; then
			report_dependency "${name}" "optional: structural search"
			return 0
		fi
	done
	printf 'ast-grep: MISSING (optional: structural search)\n'
}

report_dependencies() {
	printf 'OMCA setup (init) -- dependency report, read-only:\n'
	report_dependency jq "required: every hook"
	report_dependency uv "required: MCP servers"
	report_dependency python3 "required: MCP servers"
	report_ast_grep
	printf 'Nothing was installed or changed. Install any MISSING entry yourself.\n'
}

run_maintenance_sweeps() {
	printf 'OMCA setup (maintenance) -- sweeps:\n'
	run_child gc-in-use-markers.sh
	run_child sweep-stale-log-entries.sh
}

TRIGGER=$(jq -r '.trigger // ""' <<<"${HOOK_INPUT}" 2>/dev/null)

case "${TRIGGER}" in
	init) SUMMARY=$(report_dependencies) ;;
	maintenance) SUMMARY=$(run_maintenance_sweeps) ;;
	*) exit 0 ;;
esac

emit_context "Setup" "${SUMMARY}"
exit 0
