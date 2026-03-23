#!/usr/bin/env bash
# PostToolUseFailure handler for Read tool failures

INPUT=$(cat)
ERROR=$(echo "${INPUT}" | jq -r '.error // .tool_error // ""' 2>/dev/null)

if echo "${ERROR}" | grep -qiE 'no such file|not found|ENOENT'; then
	ADVICE="File not found. Use Glob to search for similar filenames, or check if the path has changed."
elif echo "${ERROR}" | grep -qiE 'permission|EACCES'; then
	ADVICE="Permission denied. The file exists but cannot be read. Try Bash(cat ...) as a workaround."
elif echo "${ERROR}" | grep -qiE 'directory|is a directory'; then
	ADVICE="Path is a directory, not a file. Use Bash(ls ...) to list contents, or Glob to find files within."
else
	exit 0
fi

jq -n --arg advice "[READ ERROR RECOVERY] ${ADVICE}" \
	'{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":$advice}}'
