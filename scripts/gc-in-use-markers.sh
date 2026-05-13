#!/bin/bash
# GC stale .in_use/ PID markers left by crashed/killed Claude Code sessions.
# Always exits 0 -- never blocks session-init.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

(
	PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
	IN_USE_DIR="${PLUGIN_ROOT}/.in_use"

	[[ -d "${IN_USE_DIR}" ]] || { echo "[gc-in-use] no .in_use dir, skipping" >&2; exit 0; }

	removed=0
	kept=0

	for f in "${IN_USE_DIR}"/*; do
		[[ -e "${f}" ]] || continue   # empty-dir glob safety
		pid="$(basename "${f}")"

		# Validate that filename is numeric (skip non-PID files)
		case "${pid}" in
			''|*[!0-9]*) kept=$((kept + 1)); continue ;;
			*) ;;  # numeric PID: fall through to liveness check below
		esac

		alive=0
		case "$(uname -s)" in
			Linux)
				# /proc/<pid> is the canonical, zero-overhead check on Linux.
				[[ -d "/proc/${pid}" ]] && alive=1
				;;
			Darwin)
				# kill -0 sends no signal; exit 0 iff process exists and is visible.
				kill -0 "${pid}" 2>/dev/null && alive=1
				;;
			*)
				# TODO(windows-liveness): use tasklist or PowerShell Get-Process
				# Windows: skip liveness check, leave marker in place.
				alive=1
				;;
		esac

		if [[ "${alive}" -eq 1 ]]; then
			kept=$((kept + 1))
		else
			rm -f -- "${f}" 2>/dev/null && removed=$((removed + 1))
		fi
	done

	echo "[gc-in-use] removed=${removed} kept=${kept}" >&2
) || log_hook_error "gc-in-use-markers: GC failed (non-fatal)" "gc-in-use-markers.sh"

exit 0
