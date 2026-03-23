#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

INPUT="${HOOK_INPUT}"

TOOL_NAME=$(echo "${INPUT}" | jq -r '.tool_name // ""' 2>/dev/null)
ERROR_MSG=$(echo "${INPUT}" | jq -r '.error // .tool_result.error // ""' 2>/dev/null)

case "${TOOL_NAME}" in
Bash | Read | Grep | Glob | WebFetch | WebSearch)
	exit 0
	;;
*)
	;;
esac

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
	MSG="[MCP ERROR RECOVERY] ${ADVICE}"
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUseFailure\", \"additionalContext\": ${ESCAPED}}}"
	exit 0
fi

if echo "${ERROR_MSG}" | grep -qiE '(invalid JSON|malformed JSON|parse error|SyntaxError|Unexpected token|JSON\.parse)'; then
	ERROR_DETAIL=$(echo "${ERROR_MSG}" | head -c 200)
	MSG="[JSON ERROR RECOVERY] JSON parse error detected in ${TOOL_NAME}. Common fixes: 1) Check for trailing commas in objects/arrays, 2) Ensure all strings are double-quoted, 3) Escape special characters in string values, 4) Verify brackets/braces are balanced. Error: ${ERROR_DETAIL}"
	ESCAPED=$(echo "${MSG}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PostToolUseFailure\", \"additionalContext\": ${ESCAPED}}}"
else
	exit 0
fi
