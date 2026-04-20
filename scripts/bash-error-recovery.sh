#!/usr/bin/env bash
# PostToolUseFailure handler for Bash commands
# Classifies: compilation error, test failure, permission denied, command not found
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

ERROR=$(jq -r '.error // .tool_error // ""' <<< "${HOOK_INPUT}")

if echo "${ERROR}" | grep -qiE 'command not found|No such file or directory.*bin'; then
	ADVICE="Command not found. Check if the tool is installed and on PATH. Try: which <command>"
elif echo "${ERROR}" | grep -qiE 'Permission denied|EACCES'; then
	ADVICE="Permission denied. Check file permissions or try with appropriate access."
elif echo "${ERROR}" | grep -qiE 'error.*compil|error TS|SyntaxError|ParseError'; then
	ADVICE="Compilation/syntax error. Read the error output carefully — fix the specific file and line mentioned."
elif echo "${ERROR}" | grep -qiE 'FAIL|AssertionError|test.*fail|expect.*received'; then
	ADVICE="Test failure. Read the failing test assertion. Check what the test expects vs what the code produces."
elif echo "${ERROR}" | grep -qiE 'exit code [1-9]|exited with'; then
	ADVICE="Non-zero exit code. Read the full output above for the specific error."
else
	exit 0  # Unknown bash error — let catch-all handle
fi

jq -n --arg advice "[BASH ERROR RECOVERY] ${ADVICE}" \
	'{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":$advice}}'
