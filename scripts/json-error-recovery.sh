#!/bin/bash

INPUT=$(cat)

TOOL_NAME=$(echo "${INPUT}" | jq -r '.tool_name // ""' 2>/dev/null)
ERROR_MSG=$(echo "${INPUT}" | jq -r '.error // .tool_result.error // ""' 2>/dev/null)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"

case "${TOOL_NAME}" in
Bash | Read | Grep | Glob | WebFetch | WebSearch)
	exit 0
	;;
*)
	;;
esac

# Task 2.2 — Error classification (shared by all branches below)
ERROR_TEXT="${ERROR_MSG}"
if echo "${ERROR_TEXT}" | grep -qiE 'rate.limit|429|timeout|ECONNRESET|ETIMEDOUT'; then
	ERROR_CLASS="transient"
elif echo "${ERROR_TEXT}" | grep -qiE 'not.found|permission|EACCES|ENOENT|invalid.*schema'; then
	ERROR_CLASS="deterministic"
else
	ERROR_CLASS="unknown"
fi

# Task 2.1 — Retry count tracking helper (shared)
_increment_error_count() {
	local key="$1"
	local counts_file="${STATE_DIR}/error-counts.json"
	mkdir -p "${STATE_DIR}"
	local current=0
	if [[ -f "${counts_file}" ]]; then
		current=$(jq -r --arg k "${key}" '.[$k] // 0' "${counts_file}" 2>/dev/null || echo "0")
	fi
	local new_count=$((current + 1))
	local tmp
	tmp=$(mktemp)
	if [[ -f "${counts_file}" ]]; then
		jq --arg k "${key}" --argjson c "${new_count}" '.[$k] = $c' "${counts_file}" >"${tmp}" 2>/dev/null || echo "{\"${key}\": ${new_count}}" >"${tmp}"
	else
		echo "{\"${key}\": ${new_count}}" >"${tmp}"
	fi
	mv "${tmp}" "${counts_file}"
	echo "${new_count}"
}

# MCP tool failure patterns
if echo "${ERROR_MSG}" | grep -qiE 'ast.grep.*not found|sg.*not found|No such file.*ast-grep'; then
	ADVICE="ast-grep binary not found. Install via: cargo install ast-grep or brew install ast-grep."
elif echo "${ERROR_MSG}" | grep -qiE 'timeout|timed out|deadline exceeded'; then
	ADVICE="MCP tool timed out. The codebase may be too large for this operation. Try narrowing the search scope."
elif echo "${ERROR_MSG}" | grep -qiE 'invalid.*yaml|yaml.*parse|YAML.*error'; then
	ADVICE="Invalid YAML in ast-grep rule. Check rule syntax — use ast_test_rule to validate before ast_find_rule."
elif echo "${ERROR_MSG}" | grep -qiE 'mcp.*error|tool.*unavailable|server.*not.*running'; then
	ADVICE="MCP server error. The omca server may need restart. Try: /reload-plugins"
fi
if [[ -n "${ADVICE:-}" ]]; then
	NEW_COUNT=$(_increment_error_count "${TOOL_NAME}:mcp_error")
	CIRCUIT_BREAKER=""
	if [[ "${NEW_COUNT}" -ge 3 ]]; then
		CIRCUIT_BREAKER=" This error has occurred 3+ times. Stop retrying the same approach. Escalate to oracle for architectural guidance or try a fundamentally different approach."
	fi
	MSG="[ERROR RECOVERY] Type: ${ERROR_CLASS} | Tool: ${TOOL_NAME} | Retry: ${NEW_COUNT}/3
[MCP ERROR RECOVERY] ${ADVICE}${CIRCUIT_BREAKER}"
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUseFailure\", \"additionalContext\": ${ESCAPED}}}"
	exit 0
fi

if echo "${ERROR_MSG}" | grep -qiE '(invalid JSON|malformed JSON|parse error|SyntaxError|Unexpected token|JSON\.parse)'; then
	NEW_COUNT=$(_increment_error_count "${TOOL_NAME}:json_error")
	CIRCUIT_BREAKER=""
	if [[ "${NEW_COUNT}" -ge 3 ]]; then
		CIRCUIT_BREAKER=" This error has occurred 3+ times. Stop retrying the same approach. Escalate to oracle for architectural guidance or try a fundamentally different approach."
	fi
	ERROR_DETAIL=$(echo "${ERROR_MSG}" | head -c 200)
	MSG="[ERROR RECOVERY] Type: ${ERROR_CLASS} | Tool: ${TOOL_NAME} | Retry: ${NEW_COUNT}/3
[JSON ERROR RECOVERY] JSON parse error detected in ${TOOL_NAME}. Common fixes: 1) Check for trailing commas in objects/arrays, 2) Ensure all strings are double-quoted, 3) Escape special characters in string values, 4) Verify brackets/braces are balanced. Error: ${ERROR_DETAIL}${CIRCUIT_BREAKER}"
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUseFailure\", \"additionalContext\": ${ESCAPED}}}"
else
	exit 0
fi
