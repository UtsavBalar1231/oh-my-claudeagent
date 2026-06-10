#!/usr/bin/env bash
# PostToolUseFailure handler for Bash commands
# Classifies: compilation error, test failure, permission denied, command not found,
#             timeout (text-match), slow failure (duration_ms probe-gated)
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

ERROR=$(jq -r '.error // ""' <<< "${HOOK_INPUT}")
DURATION_MS=$(jq -r '.duration_ms // empty' <<< "${HOOK_INPUT}" 2>/dev/null)

if echo "${ERROR}" | grep -qiE 'command not found|No such file or directory.*bin'; then
	ADVICE="Command not found. Check if the tool is installed and on PATH. Try: which <command>"
elif echo "${ERROR}" | grep -qiE 'Permission denied|EACCES'; then
	ADVICE="Permission denied. Check file permissions or try with appropriate access."
elif echo "${ERROR}" | grep -qiE 'compil.*error|compilation|error TS|SyntaxError|ParseError'; then
	ADVICE="Compilation/syntax error. Read the error output carefully — fix the specific file and line mentioned."
elif echo "${ERROR}" | grep -qiE 'FAIL|AssertionError|test.*fail|expect.*received'; then
	ADVICE="Test failure. Read the failing test assertion. Check what the test expects vs what the code produces."
elif echo "${ERROR}" | grep -qiE 'exit code [1-9]|exited with'; then
	ADVICE="Non-zero exit code. Read the full output above for the specific error."
elif echo "${ERROR}" | grep -qiE 'timed out|timeout|Command timed out'; then
	ADVICE="Command timed out. Consider: run_in_background=true for long operations, a larger timeout param, or narrow the scope (e.g. target a single test file)."
else
	# duration_ms probe: unclassified error that took ≥120 s — coach toward backgrounding
	if [[ -n "${DURATION_MS}" ]] && (( DURATION_MS >= 120000 )); then
		ADVICE="Command ran for over 2 minutes before failing. Consider run_in_background=true, a larger timeout param, or narrowing scope (e.g. run a single test file)."
	else
		exit 0  # Unknown bash error — let catch-all handle
	fi
fi

emit_context "PostToolUseFailure" "[BASH ERROR RECOVERY] ${ADVICE}"
