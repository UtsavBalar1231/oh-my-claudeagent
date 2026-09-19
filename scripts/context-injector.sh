#!/bin/bash

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

_HOOK_START=$(epoch_ns)

hook_is_disabled "context-injector" && exit 0

STATE_DIR="${HOOK_STATE_DIR}"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"

read -r FILE_PATH TOOL_NAME < <(jq -r '[.tool_input.file_path // "", .tool_name // ""] | @tsv' <<< "${HOOK_INPUT}")
IS_READ_EVENT=false
[[ "${TOOL_NAME}" == "Read" ]] && IS_READ_EVENT=true

if [[ -z "${FILE_PATH}" ]] || [[ ! -f "${FILE_PATH}" ]]; then
	exit 0
fi

# Worktree-safe root: walk up from the accessed file testing -e (not -d) ".git",
# since a linked worktree's ".git" is a file (gitdir pointer), not a directory.
# Caps at "/"; falls back to HOOK_PROJECT_ROOT when no repo boundary is found, so a
# worktree file's AGENTS.md walk and .omca/rules scan never cross into the parent repo.
PROJECT_ROOT=""
WALK_DIR=$(dirname "${FILE_PATH}")
while [[ "${WALK_DIR}" != "/" ]]; do
	if [[ -e "${WALK_DIR}/.git" ]]; then
		PROJECT_ROOT="${WALK_DIR}"
		break
	fi
	WALK_DIR=$(dirname "${WALK_DIR}")
done
[[ -z "${PROJECT_ROOT}" ]] && PROJECT_ROOT="${HOOK_PROJECT_ROOT}"

CACHE_FILE="${STATE_DIR}/injected-context-dirs.json"
if [[ ! -f "${CACHE_FILE}" ]]; then
	echo '{}' >"${CACHE_FILE}"
fi

FILE_DIR=$(dirname "${FILE_PATH}")
CONTEXT_PARTS=""

# 8000 chars, under the platform's 10000-char per-string hook output cap with margin. Past
# the cap the payload is replaced by a file path plus preview Claude is not asked to read.
INJECTED_CONTEXT_BUDGET_CHARS=8000
# Held back from the budget above so the dropped-items marker always fits.
DROPPED_MARKER_RESERVE_CHARS=400

DROPPED_PATHS=()

# Returns non-zero on a drop so the caller can skip that item's dedup-cache write, leaving
# it to inject on a later event.
append_within_budget() {
	local part="$1" path="$2"
	if ((${#CONTEXT_PARTS} + ${#part} > INJECTED_CONTEXT_BUDGET_CHARS - DROPPED_MARKER_RESERVE_CHARS)); then
		DROPPED_PATHS+=("${path}")
		return 1
	fi
	CONTEXT_PARTS+="${part}"
	return 0
}

# Native AGENTS.md loading is documented as active only while no project-level CLAUDE.md
# exists on the path; where it is active the excerpt below duplicates it. No signal a hook
# can read reports whether it is actually live, and a probe on 2.1.278 found it inactive,
# so the skip is opt-in through OMCA_NATIVE_AGENTS_MD=1 and off by default.
project_claude_md_on_path() {
	local dir="$1"
	while :; do
		if [[ -f "${dir}/CLAUDE.md" ]] || [[ -f "${dir}/.claude/CLAUDE.md" ]] || [[ -f "${dir}/CLAUDE.local.md" ]]; then
			return 0
		fi
		[[ "${dir}" == "/" || "${dir}" == "${PROJECT_ROOT}" ]] && return 1
		dir=$(dirname "${dir}")
	done
}

SKIP_AGENTS_MD=false
if [[ "${OMCA_NATIVE_AGENTS_MD:-}" == "1" ]] && ! project_claude_md_on_path "${FILE_DIR}"; then
	SKIP_AGENTS_MD=true
fi

if [[ "${IS_READ_EVENT}" == "true" ]]; then
CURRENT_DIR="${FILE_DIR}"
while true; do
	# M-6: mtime-keyed cache — include AGENTS.md mtime so edits to the file invalidate the
	# cached injection and re-inject with fresh content on next read event.
	AGENTS_MTIME=""
	if [[ -f "${CURRENT_DIR}/AGENTS.md" ]]; then
		# stat portable: Linux uses -c %Y; macOS uses -f %m.
		AGENTS_MTIME=$(stat -c %Y "${CURRENT_DIR}/AGENTS.md" 2>/dev/null \
			|| stat -f %m "${CURRENT_DIR}/AGENTS.md" 2>/dev/null \
			|| echo "0")
	fi
	CACHE_KEY="${CURRENT_DIR}|${AGENTS_MTIME}"

	ALREADY_INJECTED=$(jq -r --arg key "${CACHE_KEY}" '.[$key] // "false"' "${CACHE_FILE}" 2>/dev/null)

	if [[ "${ALREADY_INJECTED}" == "false" ]]; then
		DIR_DROPPED=false
		if [[ "${SKIP_AGENTS_MD}" == "false" ]] && [[ -f "${CURRENT_DIR}/AGENTS.md" ]]; then
			# 2000 bytes, line-respecting — awk accumulates byte count per line (length+newline)
			# and exits before the line that would exceed 2000 bytes, so we never cut mid-codepoint
			# the way head -c 2000 could on multi-byte sequences.
			AGENTS_CONTENT=$(awk 'BEGIN{n=0}{n+=length($0)+1; if(n>2000)exit; print}' "${CURRENT_DIR}/AGENTS.md")
			DOC_PART="[AGENTS.md from ${CURRENT_DIR}]: ${AGENTS_CONTENT}"
			if [[ "$(wc -c <"${CURRENT_DIR}/AGENTS.md")" -gt 2000 ]]; then
				DOC_PART+=" (truncated, read full file at ${CURRENT_DIR}/AGENTS.md)"
			fi
			DOC_PART+=$'\n'
			append_within_budget "${DOC_PART}" "${CURRENT_DIR}/AGENTS.md" || DIR_DROPPED=true
		fi

		if [[ -f "${CURRENT_DIR}/README.md" ]]; then
			# 2000 bytes, line-respecting — same awk idiom as AGENTS.md above.
			README_CONTENT=$(awk 'BEGIN{n=0}{n+=length($0)+1; if(n>2000)exit; print}' "${CURRENT_DIR}/README.md")
			DOC_PART="[README.md from ${CURRENT_DIR}]: ${README_CONTENT}"
			if [[ "$(wc -c <"${CURRENT_DIR}/README.md")" -gt 2000 ]]; then
				DOC_PART+=" (truncated, read full file at ${CURRENT_DIR}/README.md)"
			fi
			DOC_PART+=$'\n'
			append_within_budget "${DOC_PART}" "${CURRENT_DIR}/README.md" || DIR_DROPPED=true
		fi

		if [[ "${DIR_DROPPED}" == "false" ]]; then
			TMP=$(mktemp)
			jq --arg key "${CACHE_KEY}" '.[$key] = "true"' "${CACHE_FILE}" >"${TMP}" && mv "${TMP}" "${CACHE_FILE}"
		fi
	fi

	if [[ "${CURRENT_DIR}" == "/" ]] || [[ "${CURRENT_DIR}" == "${PROJECT_ROOT}" ]]; then
		break
	fi
	CURRENT_DIR=$(dirname "${CURRENT_DIR}")
done
fi

# Project rules are collected first, so a same-named plugin-shipped rule is shadowed and
# a user can override any shipped rule by creating a file of the same basename. The dedup
# key below is realpath-based and never collapses two paths, so filename precedence is the
# only thing preventing a shipped rule and its override from both injecting.
RULE_FILES=()
SEEN_RULE_NAMES=""
for RULES_DIR in "${PROJECT_ROOT}/.omca/rules" "${PLUGIN_ROOT}/rules"; do
	[[ -d "${RULES_DIR}" ]] || continue
	for RULE_FILE in "${RULES_DIR}"/*.md; do
		[[ -f "${RULE_FILE}" ]] || continue
		RULE_NAME=$(basename "${RULE_FILE}")
		case " ${SEEN_RULE_NAMES} " in
			*" ${RULE_NAME} "*) continue ;;
			*) ;;
		esac
		SEEN_RULE_NAMES+=" ${RULE_NAME}"
		RULE_FILES+=("${RULE_FILE}")
	done
done

for RULE_FILE in "${RULE_FILES[@]}"; do
	RULE_FIRST_LINE=$(head -1 "${RULE_FILE}")
	PATTERN=$(printf '%s' "${RULE_FIRST_LINE}" | sed -n 's/^# pattern: //p')
	if [[ -n "${PATTERN}" ]]; then
		BASENAME=$(basename "${FILE_PATH}")
		# shellcheck disable=SC2053
		if [[ "${BASENAME}" == ${PATTERN} ]]; then
			RULE_TAIL=$(tail -n +2 "${RULE_FILE}")
			# 1000 chars — rule body cap; smaller than 2000-byte doc cap (rules are denser).
			RULE_CONTENT="${RULE_TAIL:0:1000}"

			# Dedup key: realpath (survives symlink aliasing) + content-hash of the
			# injected body (survives edits — a changed rule re-injects). Namespaced
			# with "rule:" to avoid colliding with the AGENTS.md/README "dir|mtime" keys
			# sharing this same cache file.
			RULE_REALPATH=$(realpath "${RULE_FILE}" 2>/dev/null || printf '%s' "${RULE_FILE}")
			RULE_HASH=$(printf '%s' "${RULE_CONTENT}" | sha256_of_stdin)

			RULE_PART="[Rule: ${PATTERN}]: ${RULE_CONTENT}"
			if [[ "${#RULE_TAIL}" -gt 1000 ]]; then
				RULE_PART+=" (truncated, read full rule at ${RULE_FILE})"
			fi
			RULE_PART+=$'\n'

			if [[ "${RULE_HASH}" == "${SHA256_UNAVAILABLE}" ]]; then
				append_within_budget "${RULE_PART}" "${RULE_FILE}"
				continue
			fi

			RULE_CACHE_KEY="rule:${RULE_REALPATH}:${RULE_HASH}"

			RULE_ALREADY_INJECTED=$(jq -r --arg key "${RULE_CACHE_KEY}" '.[$key] // "false"' "${CACHE_FILE}" 2>/dev/null)
			if [[ "${RULE_ALREADY_INJECTED}" == "false" ]] && append_within_budget "${RULE_PART}" "${RULE_FILE}"; then
				RULE_TMP=$(mktemp)
				jq --arg key "${RULE_CACHE_KEY}" '.[$key] = "true"' "${CACHE_FILE}" >"${RULE_TMP}" && mv "${RULE_TMP}" "${CACHE_FILE}"
			fi
		fi
	fi
done

if ((${#DROPPED_PATHS[@]} > 0)); then
	MARKER="[context budget reached, ${#DROPPED_PATHS[@]} item(s) deferred to a later event:"
	for DROPPED_PATH in "${DROPPED_PATHS[@]}"; do
		CANDIDATE="${MARKER} ${DROPPED_PATH}]"$'\n'
		((${#CONTEXT_PARTS} + ${#CANDIDATE} <= INJECTED_CONTEXT_BUDGET_CHARS)) || break
		MARKER="${MARKER} ${DROPPED_PATH}"
	done
	CONTEXT_PARTS+="${MARKER}]"$'\n'
fi

if [[ -n "${CONTEXT_PARTS}" ]]; then
	ESCAPED=$(echo "${CONTEXT_PARTS}" | jq -Rs .)
	hook_timing_log "${_HOOK_START}"
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": ${ESCAPED}}}"
else
	hook_timing_log "${_HOOK_START}"
	exit 0
fi
