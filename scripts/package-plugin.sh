#!/bin/bash
# scripts/package-plugin.sh — Package OMCA plugin into a clean distribution directory
# Usage: scripts/package-plugin.sh <dest_dir> [--dry-run] [--version <N.N.N>]

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR=""
DRY_RUN=""
VERSION=""

# parse args
while [[ $# -gt 0 ]]; do
	case "$1" in
	--dry-run)
		DRY_RUN="1"
		shift
		;;
	--version)
		VERSION="$2"
		shift 2
		;;
	-*)
		echo "Unknown option: $1" >&2
		echo "Usage: $0 <dest_dir> [--dry-run] [--version <N.N.N>]" >&2
		exit 1
		;;
	*)
		if [[ -z "${DEST_DIR}" ]]; then
			DEST_DIR="$1"
		else
			echo "Unexpected argument: $1" >&2
			echo "Usage: $0 <dest_dir> [--dry-run] [--version <N.N.N>]" >&2
			exit 1
		fi
		shift
		;;
	esac
done

if [[ -z "${DEST_DIR}" ]]; then
	echo "Usage: $0 <dest_dir> [--dry-run] [--version <N.N.N>]" >&2
	exit 1
fi

# Determine version
if [[ -z "${VERSION}" ]]; then
	VERSION=$(jq -r '.version' "${PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "unknown")
fi

# Build rsync command
RSYNC_ARGS=(-a --delete)
[[ -n "${DRY_RUN}" ]] && RSYNC_ARGS+=(--dry-run --verbose)

EXCLUDES=(
	'.git/'
	'.omc/'
	'.omca/'
	'.mypy_cache/'
	'.pytest_cache/'
	'.ruff_cache/'
	'.venv/'
	'UPGRADE.md'
	'TODO.md'
	'CLAUDE.md'
	'.sisyphus/'
	'.claude/plans/'
	'benchmarks/'
	'tests/'
	'*.pyc'
	'__pycache__/'
	'node_modules/'
)
for ex in "${EXCLUDES[@]}"; do
	RSYNC_ARGS+=(--exclude "${ex}")
done

if [[ -n "${DRY_RUN}" ]]; then
	echo "[dry-run] packaging v${VERSION} → ${DEST_DIR}"
else
	mkdir -p "${DEST_DIR}"
	echo "packaging v${VERSION} → ${DEST_DIR}"
fi

rsync "${RSYNC_ARGS[@]}" "${PLUGIN_ROOT}/" "${DEST_DIR}/"
