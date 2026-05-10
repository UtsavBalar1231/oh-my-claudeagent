#!/usr/bin/env bash
# PostToolUseFailure handler for Read tool failures
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

ERROR=$(jq -r '.error // ""' <<< "${HOOK_INPUT}")

if echo "${ERROR}" | grep -qiE 'no such file|not found|ENOENT'; then
	ADVICE="File not found. Use Glob to search for similar filenames, or check if the path has changed."
elif echo "${ERROR}" | grep -qiE 'permission|EACCES'; then
	ADVICE="Permission denied. The file exists but cannot be read. Use the file_read MCP tool (via ToolSearch) for files outside the project root. Fallback: Bash(cat /path) if MCP tools are unavailable."
elif echo "${ERROR}" | grep -qiE 'directory|is a directory'; then
	ADVICE="Path is a directory, not a file. Use Bash(ls ...) to list contents, or Glob to find files within."
else
	exit 0
fi

emit_context "PostToolUseFailure" "[READ ERROR RECOVERY] ${ADVICE}"
