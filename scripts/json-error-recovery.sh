#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"


TOOL_NAME=$(jq -r '.tool_name // ""' <<< "${HOOK_INPUT}")
ERROR_MSG=$(jq -r '.error // ""' <<< "${HOOK_INPUT}")
ERROR_COUNTS_FILE="${HOOK_STATE_DIR}/error-counts.json"
ERROR_KEY="${TOOL_NAME}:json_error"

# Tools with dedicated per-tool PostToolUseFailure handlers — skip to prevent double-fire.
# edit-error-recovery.sh handles Edit, read-error-recovery.sh handles Read,
# bash-error-recovery.sh handles Bash, delegate-retry.sh handles Agent.
case "${TOOL_NAME}" in
Edit | Read | Bash | Agent | Grep | Glob | WebFetch | WebSearch)
	exit 0
	;;
*)
	;;
esac

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
	MSG="[MCP ERROR RECOVERY] ${ADVICE}"
elif echo "${ERROR_MSG}" | grep -qiE '(invalid JSON|malformed JSON|parse error|SyntaxError|Unexpected token|JSON\.parse)'; then
	# 200 bytes — ERROR_MSG cap; same as delegate-retry.sh; shows parse-error location.
	ERROR_DETAIL=$(echo "${ERROR_MSG}" | head -c 200)
	MSG="[JSON ERROR RECOVERY] JSON parse error detected in ${TOOL_NAME}. Common fixes: 1) Check for trailing commas in objects/arrays, 2) Ensure all strings are double-quoted, 3) Escape special characters in string values, 4) Verify brackets/braces are balanced. Error: ${ERROR_DETAIL}"
else
	exit 0
fi

NEW_COUNT=$(error_count_bump "${ERROR_KEY}" "${ERROR_MSG}")

# 3 — circuit-breaker threshold: two failures are retriable (transient MCP hiccups); third signals a stuck loop.
CIRCUIT_BREAKER=""
if [[ "${NEW_COUNT}" -ge 3 ]]; then
	TIMELINE=$(jq -r --arg key "${ERROR_KEY}" \
		'(.[$key].last_errors // []) | reverse | to_entries | map("\(.key + 1)) \(.value)") | join(" ")' \
		"${ERROR_COUNTS_FILE}" 2>/dev/null)
	CIRCUIT_BREAKER=" This error has occurred 3+ times. Attempts: ${TIMELINE}. Stop retrying the same approach. Escalate to oracle for architectural guidance or try a fundamentally different approach."
fi

emit_context "PostToolUseFailure" "${MSG}${CIRCUIT_BREAKER}"
