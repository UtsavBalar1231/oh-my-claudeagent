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
# degrades gracefully.
SESSION_ID="${CLAUDE_SESSION_ID:-$(date +%s)-$$}"

# One-time migration: merge legacy Task:delegate_error counter key → Agent:delegate_error.
# Pre-v2.0 delegate-retry.sh used tool_name // "Task"; the canonical platform name is Agent.
# Shape-agnostic: entries are now EITHER a bare int (legacy) OR an object
# {count, last_failure_at, last_errors} (error_count_bump helper, common.sh) — a
# naive "+ N" merge breaks on the object shape, so counts/errors/timestamps are
# merged per-field regardless of which side is which shape.
COUNTS_FILE="${STATE_DIR}/error-counts.json"
if [[ -f "${COUNTS_FILE}" ]] && jq -e 'has("Task:delegate_error")' "${COUNTS_FILE}" >/dev/null 2>&1; then
	LEGACY_COUNT=$(jq -r '."Task:delegate_error" | if type == "object" then (.count // 0) else (. // 0) end' "${COUNTS_FILE}")
	TMP_MIGRATION=$(mktemp)
	jq --argjson legacy "${LEGACY_COUNT}" '
		def as_count: if type == "object" then (.count // 0) else (. // 0) end;
		def as_errors: if type == "object" then (.last_errors // []) else [] end;
		def as_failure_at: if type == "object" then (.last_failure_at // null) else null end;
		(."Task:delegate_error") as $legacy_entry
		| (."Agent:delegate_error" // 0) as $target
		| del(."Task:delegate_error")
		| ."Agent:delegate_error" = (
			if ($target | type) == "object" or ($legacy_entry | type) == "object" then
				{
					count: (($target | as_count) + ($legacy_entry | as_count)),
					last_failure_at: (($target | as_failure_at) // ($legacy_entry | as_failure_at)),
					last_errors: (($target | as_errors) + ($legacy_entry | as_errors) | .[0:3])
				}
			else
				($target | as_count) + ($legacy_entry | as_count)
			end
		)
	' "${COUNTS_FILE}" >"${TMP_MIGRATION}" && mv "${TMP_MIGRATION}" "${COUNTS_FILE}"
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
echo '{}' >"${STATE_DIR}/subagent-models.json"
rm -f "${STATE_DIR}/plan-continuation.json" "${STATE_DIR}/tool-loop-window.json" "${STATE_DIR}/delegation-counter.json"
mkdir -p "${STATE_DIR}/worktrees"

if [[ -n "${DATE_BLOCK}" ]]; then
	CONTEXT=$(printf '%s\nSession %s initialized. State directory: %s' "${DATE_BLOCK}" "${SESSION_ID}" "${STATE_DIR}" | jq -Rs .)
else
	CONTEXT=$(printf 'Session %s initialized. State directory: %s' "${SESSION_ID}" "${STATE_DIR}" | jq -Rs .)
fi

PLUGIN_ROOT_RESOLVE="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"

# Self-heal the plan registry before anything resolves against it: prune plans
# that are checkbox-complete or whose file is gone AND that no session is bound
# to. Without this a finished-but-never-cleared plan lingers in boulder.json
# forever (the write-path GC only runs on boulder_write) and leaks into session
# titles and downstream resolvers. Fail-soft: GC errors never block the hook.
python3 "${PLUGIN_ROOT_RESOLVE}/servers/tools/boulder_gc.py" "${HOOK_PROJECT_ROOT}" >/dev/null 2>&1 || true

# Emit sessionTitle only when the resolver shim binds this session to a plan AND
# that plan's active_plan file still exists. Defensive: any resolve error, an
# unbound session, or a stale active_plan pointing at a deleted file, leaves
# SESSION_TITLE empty → key is omitted.
BOUND_PLAN=$(python3 "${PLUGIN_ROOT_RESOLVE}/servers/tools/boulder_resolve.py" "$(resolve_session_id)" "${HOOK_PROJECT_ROOT}" 2>/dev/null || echo '{}')
SESSION_TITLE=""
ACTIVE_PLAN=$(jq -r '.active_plan // empty' <<< "${BOUND_PLAN}" 2>/dev/null || true)
if [[ -n "${ACTIVE_PLAN}" && -f "${ACTIVE_PLAN}" ]]; then
	SESSION_TITLE=$(jq -r '.plan_name // empty' <<< "${BOUND_PLAN}" 2>/dev/null || true)
fi

if [[ -n "${SESSION_TITLE}" ]]; then
	jq -n \
		--argjson ctx "${CONTEXT}" \
		--arg title "OMCA: ${SESSION_TITLE}" \
		'{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx, sessionTitle: $title}}'
else
	echo "{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": ${CONTEXT}}}"
fi
