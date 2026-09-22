#!/usr/bin/env bash
# PostToolUseFailure handler for Bash commands
# Classifies: compilation error, test failure, permission denied, command not found,
#             timeout (text-match), slow failure (duration_ms probe-gated)
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

ERROR=$(jq -r '.error // ""' <<< "${HOOK_INPUT}")
DURATION_MS=$(jq -r '.duration_ms // empty' <<< "${HOOK_INPUT}" 2>/dev/null)
TOOL_NAME=$(jq -r '.tool_name // "Bash"' <<< "${HOOK_INPUT}")
ERROR_COUNTS_FILE="${HOOK_STATE_DIR}/error-counts.json"
ERROR_KEY="${TOOL_NAME}:bash_error"

if echo "${ERROR}" | grep -qiE 'command not found|No such file or directory.*bin'; then
	ADVICE="Command not found. Check if the tool is installed and on PATH. Try: which <command>"
elif echo "${ERROR}" | grep -qiE 'Permission denied|EACCES'; then
	ADVICE="Permission denied. Check file permissions or try with appropriate access."
elif echo "${ERROR}" | grep -qiE 'compil.*error|compilation|error TS|SyntaxError|ParseError|FAIL|AssertionError|test.*fail|expect.*received|exit code [1-9]|exited with'; then
	# The failure output already reaches the model; these classes only feed the counter.
	ADVICE=""
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

NEW_COUNT=$(error_count_bump "${ERROR_KEY}" "${ERROR}")

# 3: circuit-breaker threshold: two failures are retriable (flaky/transient); third signals a stuck loop.
CIRCUIT_BREAKER=""
if [[ "${NEW_COUNT}" -ge 3 ]]; then
	TIMELINE=$(jq -r --arg key "${ERROR_KEY}" \
		'(.[$key].last_errors // []) | reverse | to_entries | map("\(.key + 1)) \(.value)") | join(" ")' \
		"${ERROR_COUNTS_FILE}" 2>/dev/null)
	CIRCUIT_BREAKER=" This tool has failed 3+ times, each failure within five minutes of the last. Attempts: ${TIMELINE}. The count covers every failure of the tool, related or not. If these are repeated attempts at one fix, stop repeating it: change the approach, or ask oracle for a diagnosis."
fi

[[ -n "${ADVICE}${CIRCUIT_BREAKER}" ]] || exit 0
emit_context "PostToolUseFailure" "[BASH ERROR RECOVERY] ${ADVICE}${CIRCUIT_BREAKER}"
