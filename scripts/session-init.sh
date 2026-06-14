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

# CLAUDE_SESSION_ID is reliable in v2.x. The fallback (epoch-PID) exists for
# pre-v2.x clients where the var may be absent. Fallback IDs will NOT match
# resolve_session_id's other lookup tiers, so cross-hook session correlation
# degrades gracefully (orphan-sweep below will simply find no match).
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

# Stale-subagent sweep: prune subagents.json .active and active-agents.json entries older
# than the 900s liveness cutoff so a new session never inherits zombie "running" agents
# (phantoms from a prior session that died without a SubagentStop). Same cutoff and
# null-epoch-keep rule as subagent-complete.sh — one liveness rule across all readers.
SWEEP_CUTOFF=$(( $(date +%s) - 900 ))
SUBAGENTS_SWEEP="${STATE_DIR}/subagents.json"
if [[ -f "${SUBAGENTS_SWEEP}" ]]; then
	TMP_SW=$(mktemp)
	if jq --argjson cutoff "${SWEEP_CUTOFF}" \
		'.active = [(.active // [])[] | select((.started_epoch == null) or (.started_epoch > $cutoff))]' \
		"${SUBAGENTS_SWEEP}" >"${TMP_SW}" 2>/dev/null; then
		mv "${TMP_SW}" "${SUBAGENTS_SWEEP}"
	else
		rm -f "${TMP_SW}"
	fi
fi
ACTIVE_AGENTS_SWEEP="${STATE_DIR}/active-agents.json"
if [[ -f "${ACTIVE_AGENTS_SWEEP}" ]]; then
	TMP_AA=$(mktemp)
	if jq --argjson cutoff "${SWEEP_CUTOFF}" \
		'[ (.[]?) | select((.started_epoch // 0) > $cutoff) ]' \
		"${ACTIVE_AGENTS_SWEEP}" >"${TMP_AA}" 2>/dev/null; then
		mv "${TMP_AA}" "${ACTIVE_AGENTS_SWEEP}"
	else
		rm -f "${TMP_AA}"
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

if [[ -n "${DATE_BLOCK}" ]]; then
	CONTEXT=$(printf '%s\nSession %s initialized. State directory: %s' "${DATE_BLOCK}" "${SESSION_ID}" "${STATE_DIR}" | jq -Rs .)
else
	CONTEXT=$(printf 'Session %s initialized. State directory: %s' "${SESSION_ID}" "${STATE_DIR}" | jq -Rs .)
fi

# Emit sessionTitle when boulder.json is present and has a plan_name.
# Defensive: any read/parse error leaves SESSION_TITLE empty → key is omitted.
BOULDER_FILE="${STATE_DIR}/boulder.json"
SESSION_TITLE=""
if [[ -f "${BOULDER_FILE}" ]]; then
	SESSION_TITLE=$(jq -r '.plan_name // empty' "${BOULDER_FILE}" 2>/dev/null || true)
fi

if [[ -n "${SESSION_TITLE}" ]]; then
	jq -n \
		--argjson ctx "${CONTEXT}" \
		--arg title "OMCA: ${SESSION_TITLE}" \
		'{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx, sessionTitle: $title}}'
else
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": ${CONTEXT}}}"
fi
