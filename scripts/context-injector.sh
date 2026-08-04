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
		if [[ -f "${CURRENT_DIR}/AGENTS.md" ]]; then
			# 2000 bytes, line-respecting — awk accumulates byte count per line (length+newline)
			# and exits before the line that would exceed 2000 bytes, so we never cut mid-codepoint
			# the way head -c 2000 could on multi-byte sequences.
			AGENTS_CONTENT=$(awk 'BEGIN{n=0}{n+=length($0)+1; if(n>2000)exit; print}' "${CURRENT_DIR}/AGENTS.md")
			CONTEXT_PARTS+="[AGENTS.md from ${CURRENT_DIR}]: ${AGENTS_CONTENT}"
			if [[ "$(wc -c <"${CURRENT_DIR}/AGENTS.md")" -gt 2000 ]]; then
				CONTEXT_PARTS+=" (truncated, read full file at ${CURRENT_DIR}/AGENTS.md)"
			fi
			CONTEXT_PARTS+=$'\n'
		fi

		if [[ -f "${CURRENT_DIR}/README.md" ]]; then
			# 2000 bytes, line-respecting — same awk idiom as AGENTS.md above.
			README_CONTENT=$(awk 'BEGIN{n=0}{n+=length($0)+1; if(n>2000)exit; print}' "${CURRENT_DIR}/README.md")
			CONTEXT_PARTS+="[README.md from ${CURRENT_DIR}]: ${README_CONTENT}"
			if [[ "$(wc -c <"${CURRENT_DIR}/README.md")" -gt 2000 ]]; then
				CONTEXT_PARTS+=" (truncated, read full file at ${CURRENT_DIR}/README.md)"
			fi
			CONTEXT_PARTS+=$'\n'
		fi

		TMP=$(mktemp)
		jq --arg key "${CACHE_KEY}" '.[$key] = "true"' "${CACHE_FILE}" >"${TMP}" && mv "${TMP}" "${CACHE_FILE}"
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

			if [[ "${RULE_HASH}" == "${SHA256_UNAVAILABLE}" ]]; then
				CONTEXT_PARTS+="[Rule: ${PATTERN}]: ${RULE_CONTENT}"
				if [[ "${#RULE_TAIL}" -gt 1000 ]]; then
					CONTEXT_PARTS+=" (truncated, read full rule at ${RULE_FILE})"
				fi
				CONTEXT_PARTS+=$'\n'
				continue
			fi

			RULE_CACHE_KEY="rule:${RULE_REALPATH}:${RULE_HASH}"

			RULE_ALREADY_INJECTED=$(jq -r --arg key "${RULE_CACHE_KEY}" '.[$key] // "false"' "${CACHE_FILE}" 2>/dev/null)
			if [[ "${RULE_ALREADY_INJECTED}" == "false" ]]; then
				CONTEXT_PARTS+="[Rule: ${PATTERN}]: ${RULE_CONTENT}"
				if [[ "${#RULE_TAIL}" -gt 1000 ]]; then
					CONTEXT_PARTS+=" (truncated, read full rule at ${RULE_FILE})"
				fi
				CONTEXT_PARTS+=$'\n'

				RULE_TMP=$(mktemp)
				jq --arg key "${RULE_CACHE_KEY}" '.[$key] = "true"' "${CACHE_FILE}" >"${RULE_TMP}" && mv "${RULE_TMP}" "${CACHE_FILE}"
			fi
		fi
	fi
done

if [[ -n "${CONTEXT_PARTS}" ]]; then
	ESCAPED=$(echo "${CONTEXT_PARTS}" | jq -Rs .)
	hook_timing_log "${_HOOK_START}"
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": ${ESCAPED}}}"
else
	hook_timing_log "${_HOOK_START}"
	exit 0
fi
