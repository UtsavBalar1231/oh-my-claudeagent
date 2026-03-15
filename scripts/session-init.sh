#!/bin/bash

INPUT=$(cat)

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"

mkdir -p "${STATE_DIR}" "${LOG_DIR}"

SESSION_ID="${CLAUDE_SESSION_ID:-$(date +%s)-$$}"

SESSION_STATE="${STATE_DIR}/session.json"
TMP_FILE=$(mktemp)
TS=$(date -Iseconds)
jq -n \
	--arg sid "${SESSION_ID}" \
	--arg ts "${TS}" \
	--arg root "${PROJECT_ROOT}" \
	'{sessionId: $sid, startedAt: $ts, projectRoot: $root, subagents: [], edits: [], activeMode: null}' \
	>"${TMP_FILE}" && mv "${TMP_FILE}" "${SESSION_STATE}"

LOG_FILE="${LOG_DIR}/sessions.jsonl"
TS2=$(date -Iseconds)
jq -nc --arg sid "${SESSION_ID}" --arg ts "${TS2}" --arg cwd "${PROJECT_ROOT}" \
	'{event: "session_start", sessionId: $sid, timestamp: $ts, cwd: $cwd}' >>"${LOG_FILE}"

echo '{}' >"${STATE_DIR}/injected-context-dirs.json"
echo '{"agentUsed": false, "toolCallCount": 0}' >"${STATE_DIR}/agent-usage.json"
mkdir -p "${STATE_DIR}/worktrees"

# Check if CLAUDE.md has OMCA configuration (only on fresh startup, not compact)
SETUP_NOTICE=""
SOURCE=$(echo "${INPUT}" | jq -r '.source // "startup"' 2>/dev/null)
if [[ "${SOURCE}" != "compact" ]]; then
	PROJECT_CLAUDE_MD="${PROJECT_ROOT}/CLAUDE.md"
	if [[ -f "${PROJECT_CLAUDE_MD}" ]] && ! grep -q "OMC:START\|omca-setup" "${PROJECT_CLAUDE_MD}" 2>/dev/null; then
		PLUGIN_ROOT_CHECK="$(cd "$(dirname "$0")/.." && pwd)"
		VERSION=$(jq -r '.version // "unknown"' "${PLUGIN_ROOT_CHECK}/.claude-plugin/plugin.json" 2>/dev/null)
		SETUP_NOTICE="\n[OMCA] Plugin behavioral spec not detected in CLAUDE.md. Run /oh-my-claudeagent:omca-setup to configure (v${VERSION})."
	fi
fi

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_MD="${PLUGIN_ROOT}/templates/claudemd.md"

if [[ -f "${PLUGIN_MD}" ]]; then
	PLUGIN_MD_CONTENT=$(cat "${PLUGIN_MD}")
	FULL_CONTEXT=$(printf "Session %s initialized.\n\n%s%b" "${SESSION_ID}" "${PLUGIN_MD_CONTENT}" "${SETUP_NOTICE}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": ${FULL_CONTEXT}}}"
else
	FALLBACK_CONTEXT=$(printf 'Session %s initialized. State directory: %s%b' "${SESSION_ID}" "${STATE_DIR}" "${SETUP_NOTICE}" | jq -Rs .)
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": ${FALLBACK_CONTEXT}}}"
fi
