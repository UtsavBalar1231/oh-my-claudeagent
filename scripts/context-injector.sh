#!/bin/bash

_HOOK_START=$(date +%s%N 2>/dev/null || date +%s)

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

PROJECT_ROOT="${HOOK_PROJECT_ROOT}"
STATE_DIR="${HOOK_STATE_DIR}"

read -r FILE_PATH TOOL_NAME < <(jq -r '[.tool_input.file_path // "", .tool_name // ""] | @tsv' <<< "${HOOK_INPUT}")
IS_READ_EVENT=false
[[ "${TOOL_NAME}" == "Read" ]] && IS_READ_EVENT=true

if [[ -z "${FILE_PATH}" ]] || [[ ! -f "${FILE_PATH}" ]]; then
	exit 0
fi

CACHE_FILE="${STATE_DIR}/injected-context-dirs.json"
if [[ ! -f "${CACHE_FILE}" ]]; then
	echo '{}' >"${CACHE_FILE}"
fi

FILE_DIR=$(dirname "${FILE_PATH}")
CONTEXT_PARTS=""

if [[ "${IS_READ_EVENT}" == "true" ]]; then
CURRENT_DIR="${FILE_DIR}"
while true; do
	ALREADY_INJECTED=$(jq -r --arg dir "${CURRENT_DIR}" '.[$dir] // "false"' "${CACHE_FILE}" 2>/dev/null)

	if [[ "${ALREADY_INJECTED}" == "false" ]]; then
		if [[ -f "${CURRENT_DIR}/AGENTS.md" ]]; then
			# 2000 bytes — truncate injected AGENTS.md to stay under 10k-char platform cap.
			AGENTS_CONTENT=$(head -c 2000 "${CURRENT_DIR}/AGENTS.md")
			CONTEXT_PARTS+="[AGENTS.md from ${CURRENT_DIR}]: ${AGENTS_CONTENT}"$'\n'
		fi

		if [[ -f "${CURRENT_DIR}/README.md" ]]; then
			# 2000 bytes — truncate injected README.md; same cap as AGENTS.md (shared budget).
			README_CONTENT=$(head -c 2000 "${CURRENT_DIR}/README.md")
			CONTEXT_PARTS+="[README.md from ${CURRENT_DIR}]: ${README_CONTENT}"$'\n'
		fi

		TMP=$(mktemp)
		jq --arg dir "${CURRENT_DIR}" '.[$dir] = "true"' "${CACHE_FILE}" >"${TMP}" && mv "${TMP}" "${CACHE_FILE}"
	fi

	if [[ "${CURRENT_DIR}" == "/" ]] || [[ "${CURRENT_DIR}" == "${PROJECT_ROOT}" ]]; then
		break
	fi
	CURRENT_DIR=$(dirname "${CURRENT_DIR}")
done
fi

RULES_DIR="${PROJECT_ROOT}/.omca/rules"
if [[ -d "${RULES_DIR}" ]]; then
	for RULE_FILE in "${RULES_DIR}"/*.md; do
		if [[ -f "${RULE_FILE}" ]]; then
			RULE_FIRST_LINE=$(head -1 "${RULE_FILE}")
			PATTERN=$(printf '%s' "${RULE_FIRST_LINE}" | sed -n 's/^# pattern: //p')
			if [[ -n "${PATTERN}" ]]; then
				BASENAME=$(basename "${FILE_PATH}")
				# shellcheck disable=SC2053
				if [[ "${BASENAME}" == ${PATTERN} ]]; then
					RULE_TAIL=$(tail -n +2 "${RULE_FILE}")
					# 1000 chars — rule body cap; smaller than 2000-byte doc cap (rules are denser).
					RULE_CONTENT="${RULE_TAIL:0:1000}"
					CONTEXT_PARTS+="[Rule: ${PATTERN}]: ${RULE_CONTENT}"$'\n'
				fi
			fi
		fi
	done
fi

if [[ -n "${CONTEXT_PARTS}" ]]; then
	ESCAPED=$(echo "${CONTEXT_PARTS}" | jq -Rs .)
	hook_timing_log "${_HOOK_START}"
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": ${ESCAPED}}}"
else
	hook_timing_log "${_HOOK_START}"
	exit 0
fi
