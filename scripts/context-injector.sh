#!/bin/bash

INPUT=$(cat)

FILE_PATH=$(echo "${INPUT}" | jq -r '.tool_input.file_path // ""' 2>/dev/null)

if [[ -z "${FILE_PATH}" ]] || [[ ! -f "${FILE_PATH}" ]]; then
	exit 0
fi

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
mkdir -p "${STATE_DIR}"

CACHE_FILE="${STATE_DIR}/injected-context-dirs.json"
if [[ ! -f "${CACHE_FILE}" ]]; then
	echo '{}' >"${CACHE_FILE}"
fi

FILE_DIR=$(dirname "${FILE_PATH}")
CONTEXT_PARTS=""

CURRENT_DIR="${FILE_DIR}"
while true; do
	DIR_KEY=$(echo "${CURRENT_DIR}" | jq -Rs .)
	ALREADY_INJECTED=$(jq -r ".[${DIR_KEY}] // \"false\"" "${CACHE_FILE}" 2>/dev/null)

	if [[ "${ALREADY_INJECTED}" == "false" ]]; then
		if [[ -f "${CURRENT_DIR}/AGENTS.md" ]]; then
			AGENTS_CONTENT=$(head -c 2000 "${CURRENT_DIR}/AGENTS.md")
			CONTEXT_PARTS+="[AGENTS.md from ${CURRENT_DIR}]: ${AGENTS_CONTENT} "
		fi

		if [[ -f "${CURRENT_DIR}/README.md" ]]; then
			README_CONTENT=$(head -c 2000 "${CURRENT_DIR}/README.md")
			CONTEXT_PARTS+="[README.md from ${CURRENT_DIR}]: ${README_CONTENT} "
		fi

		TMP=$(mktemp)
		jq --arg dir "${CURRENT_DIR}" '.[$dir] = "true"' "${CACHE_FILE}" >"${TMP}" && mv "${TMP}" "${CACHE_FILE}"
	fi

	if [[ "${CURRENT_DIR}" == "/" ]] || [[ "${CURRENT_DIR}" == "${PROJECT_ROOT}" ]]; then
		break
	fi
	CURRENT_DIR=$(dirname "${CURRENT_DIR}")
done

RULES_DIR="${PROJECT_ROOT}/.omca/rules"
if [[ -d "${RULES_DIR}" ]]; then
	for RULE_FILE in "${RULES_DIR}"/*.md; do
		if [[ -f "${RULE_FILE}" ]]; then
			PATTERN=$(head -1 "${RULE_FILE}" | sed -n 's/^# pattern: //p')
			if [[ -n "${PATTERN}" ]]; then
				BASENAME=$(basename "${FILE_PATH}")
				# shellcheck disable=SC2053
				if [[ "${BASENAME}" == ${PATTERN} ]]; then
					RULE_CONTENT=$(tail -n +2 "${RULE_FILE}" | head -c 1000)
					CONTEXT_PARTS+="[Rule: ${PATTERN}]: ${RULE_CONTENT} "
				fi
			fi
		fi
	done
fi

if [[ -n "${CONTEXT_PARTS}" ]]; then
	ESCAPED=$(echo "${CONTEXT_PARTS}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUse\", \"additionalContext\": ${ESCAPED}}}"
else
	exit 0
fi
