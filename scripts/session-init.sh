#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

PROJECT_ROOT="${HOOK_PROJECT_ROOT}"
STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

# PLUGIN_DATA venv sync (v2.1.78+) — ensure MCP server dependencies persist across updates
if [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]]; then
	PLUGIN_ROOT_SYNC="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
	if ! diff -q "${PLUGIN_ROOT_SYNC}/servers/pyproject.toml" "${CLAUDE_PLUGIN_DATA}/pyproject.toml" >/dev/null 2>&1; then
		mkdir -p "${CLAUDE_PLUGIN_DATA}"
		# Run uv sync BEFORE updating cached pyproject. Reverse order silently masks failures:
		# cached pyproject updated → next session sees diff-clean → skips sync → venv stays broken.
		if UV_PROJECT_ENVIRONMENT="${CLAUDE_PLUGIN_DATA}/.venv" uv sync --project "${PLUGIN_ROOT_SYNC}/servers" --quiet 2>/dev/null; then
			cp "${PLUGIN_ROOT_SYNC}/servers/pyproject.toml" "${CLAUDE_PLUGIN_DATA}/pyproject.toml" 2>/dev/null
		fi
	fi
fi

SESSION_ID="${CLAUDE_SESSION_ID:-$(date +%s)-$$}"

# Cross-session orphan-marker sweep: remove a pending-final-verify.json from a prior session
# so the Stop hook does not resolve against an unrelated plan's SHA. Skipped on compact —
# CLAUDE_SESSION_ID stability across compact is unverified; wiping would risk a live marker.
# Mirrors the SOURCE guard at line 53.
SWEEP_SOURCE=$(jq -r '.source // "startup"' <<< "${HOOK_INPUT}")
PENDING_MARKER="${STATE_DIR}/pending-final-verify.json"
if [[ "${SWEEP_SOURCE}" != "compact" ]] && [[ -f "${PENDING_MARKER}" ]]; then
	OLD_SID=$(jq_read "${PENDING_MARKER}" '.session_id // ""')
	if [[ -n "${OLD_SID}" && "${OLD_SID}" != "null" && "${OLD_SID}" != "${SESSION_ID}" ]]; then
		rm -f "${PENDING_MARKER}"
		log_hook_error "cleared cross-session orphan marker (previous session_id=${OLD_SID})" "session-init.sh"
	fi
fi

# One-time migration: merge legacy Task:delegate_error counter key → Agent:delegate_error.
# Pre-v2.0 delegate-retry.sh used tool_name // "Task"; the canonical platform name is Agent.
# Guard: only run if file exists AND contains the legacy key (idempotent on clean installs).
COUNTS_FILE="${STATE_DIR}/error-counts.json"
if [[ -f "${COUNTS_FILE}" ]] && jq -e 'has("Task:delegate_error")' "${COUNTS_FILE}" >/dev/null 2>&1; then
	LEGACY_COUNT=$(jq -r '."Task:delegate_error" // 0' "${COUNTS_FILE}")
	TMP_MIGRATION=$(mktemp)
	jq --argjson legacy "${LEGACY_COUNT}" \
		'del(."Task:delegate_error") | ."Agent:delegate_error" = ((."Agent:delegate_error" // 0) + $legacy)' \
		"${COUNTS_FILE}" >"${TMP_MIGRATION}" && mv "${TMP_MIGRATION}" "${COUNTS_FILE}"
	log_hook_error "migrated Task:delegate_error (${LEGACY_COUNT}) → Agent:delegate_error" "session-init.sh"
fi

SESSION_STATE="${STATE_DIR}/session.json"
TMP_FILE=$(mktemp)
TS=$(date -Iseconds)

DATE_CONTEXT=$(LC_TIME=C date '+%A %B %d %Y %H' 2>/dev/null || echo "")
if [[ -n "${DATE_CONTEXT}" ]]; then
	read -r DOW MON DAY YEAR HOUR <<< "${DATE_CONTEXT}"
	DATE_BLOCK="[CURRENT DATE] Today is ${DOW}, ${MON} ${DAY}, ${YEAR}. Current hour: ${HOUR} (local)."
else
	DATE_BLOCK=""
fi

jq -n \
	--arg sid "${SESSION_ID}" \
	--arg ts "${TS}" \
	--arg root "${PROJECT_ROOT}" \
	'{sessionId: $sid, startedAt: $ts, projectRoot: $root, subagents: [], edits: [], activeMode: null}' \
	>"${TMP_FILE}" && mv "${TMP_FILE}" "${SESSION_STATE}"

LOG_FILE="${LOG_DIR}/sessions.jsonl"
jq -nc --arg sid "${SESSION_ID}" --arg ts "${TS}" --arg cwd "${PROJECT_ROOT}" \
	'{event: "session_start", sessionId: $sid, timestamp: $ts, cwd: $cwd}' >>"${LOG_FILE}"

echo '{}' >"${STATE_DIR}/injected-context-dirs.json"
echo '{"agentUsed": false, "toolCallCount": 0}' >"${STATE_DIR}/agent-usage.json"
mkdir -p "${STATE_DIR}/worktrees"

SETUP_NOTICE=""
OMCA_CONFIGURED=0
SOURCE=$(jq -r '.source // "startup"' <<< "${HOOK_INPUT}")
if [[ "${SOURCE}" != "compact" ]]; then
	GLOBAL_CLAUDE_MD="${HOME}/.claude/CLAUDE.md"
	PROJECT_CLAUDE_MD="${PROJECT_ROOT}/CLAUDE.md"
	if [[ -f "${GLOBAL_CLAUDE_MD}" ]] && grep -q "omca-setup" "${GLOBAL_CLAUDE_MD}" 2>/dev/null; then
		OMCA_CONFIGURED=1
	fi

	# -E (ERE) required: \| is GNU grep BRE alternation; BSD grep treats it as literal |
	if [[ "${OMCA_CONFIGURED}" -eq 0 ]] && [[ -f "${PROJECT_CLAUDE_MD}" ]] && grep -qE "OMC:START|omca-setup" "${PROJECT_CLAUDE_MD}" 2>/dev/null; then
		OMCA_CONFIGURED=1
	fi

	# Check CLAUDE.local.md (v2.1.85+ personal project instructions, not checked into git)
	PROJECT_CLAUDE_LOCAL_MD="${PROJECT_ROOT}/CLAUDE.local.md"
	# -E (ERE) required: \| is GNU grep BRE alternation; BSD grep treats it as literal |
	if [[ "${OMCA_CONFIGURED}" -eq 0 ]] && [[ -f "${PROJECT_CLAUDE_LOCAL_MD}" ]] && grep -qE "OMC:START|omca-setup" "${PROJECT_CLAUDE_LOCAL_MD}" 2>/dev/null; then
		OMCA_CONFIGURED=1
	fi

	if [[ "${OMCA_CONFIGURED}" -eq 0 ]]; then
		PLUGIN_ROOT_CHECK="$(cd "$(dirname "$0")/.." && pwd)"
		# Reverted helper migration: plugin.json may not exist in all installations;
		# the 2>/dev/null guard and inline pattern are required here.
		VERSION=$(jq -r '.version // "unknown"' "${PLUGIN_ROOT_CHECK}/.claude-plugin/plugin.json" 2>/dev/null)
		SETUP_NOTICE="\n[OMCA] Plugin not configured. Run /oh-my-claudeagent:omca-setup to set up orchestration (v${VERSION})."
	fi
fi

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_MD="${PLUGIN_ROOT}/templates/claudemd.md"

if [[ "${OMCA_CONFIGURED}" -eq 1 ]]; then
	if [[ -n "${DATE_BLOCK}" ]]; then
		SHORT_CONTEXT=$(printf '%s\nSession %s initialized.%b' "${DATE_BLOCK}" "${SESSION_ID}" "${SETUP_NOTICE}" | jq -Rs .)
	else
		SHORT_CONTEXT=$(printf 'Session %s initialized.%b' "${SESSION_ID}" "${SETUP_NOTICE}" | jq -Rs .)
	fi
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": ${SHORT_CONTEXT}}}"
elif [[ -f "${PLUGIN_MD}" ]]; then
	# No CLAUDE.md setup — inject full behavioral template so plugin works out of the box
	TEMPLATE=$(cat "${PLUGIN_MD}")
	if [[ -n "${DATE_BLOCK}" ]]; then
		FULL_CONTEXT=$(printf '%s\nSession %s initialized.\n\n%s%b' "${DATE_BLOCK}" "${SESSION_ID}" "${TEMPLATE}" "${SETUP_NOTICE}" | jq -Rs .)
	else
		FULL_CONTEXT=$(printf 'Session %s initialized.\n\n%s%b' "${SESSION_ID}" "${TEMPLATE}" "${SETUP_NOTICE}" | jq -Rs .)
	fi
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": ${FULL_CONTEXT}}}"
else
	if [[ -n "${DATE_BLOCK}" ]]; then
		FALLBACK_CONTEXT=$(printf '%s\nSession %s initialized. State directory: %s%b' "${DATE_BLOCK}" "${SESSION_ID}" "${STATE_DIR}" "${SETUP_NOTICE}" | jq -Rs .)
	else
		FALLBACK_CONTEXT=$(printf 'Session %s initialized. State directory: %s%b' "${SESSION_ID}" "${STATE_DIR}" "${SETUP_NOTICE}" | jq -Rs .)
	fi
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": ${FALLBACK_CONTEXT}}}"
fi
