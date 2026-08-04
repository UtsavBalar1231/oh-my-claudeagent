#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

PROJECT_ROOT="${HOOK_PROJECT_ROOT}"
STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

start_venv_sync() {
	[[ -n "${CLAUDE_PLUGIN_DATA:-}" ]] || return 0
	local plugin_root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
	diff -q "${plugin_root}/servers/pyproject.toml" "${CLAUDE_PLUGIN_DATA}/pyproject.toml" >/dev/null 2>&1 && return 0
	mkdir -p "${CLAUDE_PLUGIN_DATA}"
	local runner=""
	command -v setsid >/dev/null 2>&1 && runner="setsid"
	# shellcheck disable=SC2016
	${runner} bash -c '
		if UV_PROJECT_ENVIRONMENT="$2/.venv" uv sync --project "$1/servers" --quiet 2>/dev/null; then
			cp "$1/servers/pyproject.toml" "$2/pyproject.toml" 2>/dev/null
		fi
	' _ "${plugin_root}" "${CLAUDE_PLUGIN_DATA}" </dev/null >/dev/null 2>&1 &
	disown 2>/dev/null
}

# resolve_session_id() ranks CLAUDE_SESSION_ID, then the SessionStart
# payload's own .session_id (the platform UUID, same as the transcript
# filename), then a stale session.json -- prefer it over CLAUDE_SESSION_ID
# alone, which is frequently unset. Epoch-PID fallback only fires when the
# payload truly lacks a session_id (pre-v2.x clients); such an id won't
# match other session-id-keyed state (e.g. boulder.json bindings).
SESSION_ID="$(resolve_session_id)"
SESSION_ID="${SESSION_ID:-$(date +%s)-$$}"

# One-time migration: merge legacy Task:delegate_error counter key → Agent:delegate_error.
# Pre-v2.0 delegate-retry.sh used tool_name // "Task"; the canonical platform name is Agent.
# Shape-agnostic: entries are now EITHER a bare int (legacy) OR an object
# {count, last_failure_at, last_errors} (error_count_bump helper, common.sh); a
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
TS=$(date -Iseconds)

# .omca/state/ is per-project and shared by every session in the project. Source
# "fork" (--fork-session with --resume or --continue, the /fork background copy,
# or /branch) means a second session is running alongside a live parent, so it
# must not reset shared files or stamp its own id into session.json. startup,
# resume, clear and compact are the same session continuing or a new session with
# no concurrent peer, so they own the reset.
SESSION_SOURCE=$(jq -r '.source // ""' <<< "${HOOK_INPUT}")
OWNS_SHARED_STATE=1
if [[ "${SESSION_SOURCE}" == "fork" ]]; then
	OWNS_SHARED_STATE=0
fi

DATE_CONTEXT=$(LC_TIME=C date '+%A %B %d %Y %H' 2>/dev/null || echo "")
if [[ -n "${DATE_CONTEXT}" ]]; then
	read -r DOW MON DAY YEAR HOUR <<< "${DATE_CONTEXT}"
	DATE_BLOCK="[CURRENT DATE] Today is ${DOW}, ${MON} ${DAY}, ${YEAR}. Current hour: ${HOUR} (local)."
else
	DATE_BLOCK=""
fi

if (( OWNS_SHARED_STATE )); then
	TMP_FILE=$(mktemp)
	jq -n \
		--arg sid "${SESSION_ID}" \
		--arg ts "${TS}" \
		--arg root "${PROJECT_ROOT}" \
		'{sessionId: $sid, startedAt: $ts, projectRoot: $root, subagents: [], edits: [], activeMode: null}' \
		>"${TMP_FILE}" && mv "${TMP_FILE}" "${SESSION_STATE}"
fi

LOG_FILE="${LOG_DIR}/sessions.jsonl"
jq -nc --arg sid "${SESSION_ID}" --arg ts "${TS}" --arg cwd "${PROJECT_ROOT}" \
	'{event: "session_start", sessionId: $sid, timestamp: $ts, cwd: $cwd}' >>"${LOG_FILE}"

if (( OWNS_SHARED_STATE )); then
	echo '{}' >"${STATE_DIR}/injected-context-dirs.json"
	echo '{}' >"${STATE_DIR}/subagent-models.json"
	rm -f "${STATE_DIR}/plan-continuation.json" "${STATE_DIR}/tool-loop-window.json" "${STATE_DIR}/delegation-counter.json"
	stop_blocks_reset
fi
mkdir -p "${STATE_DIR}/worktrees"

ERROR_LOG="${LOG_DIR}/hook-errors.jsonl"
ERROR_CURSOR="${STATE_DIR}/hook-errors-cursor"
ERROR_BLOCK=""
if [[ -f "${ERROR_LOG}" ]]; then
	read -r CURSOR CURSOR_BYTES < <(cat "${ERROR_CURSOR}" 2>/dev/null)
	[[ "${CURSOR}" =~ ^[0-9]+$ ]] || CURSOR=0
	[[ "${CURSOR_BYTES}" =~ ^[0-9]+$ ]] || CURSOR_BYTES=0
	TOTAL_LINES=$(wc -l <"${ERROR_LOG}" 2>/dev/null | tr -d ' ')
	TOTAL_BYTES=$(wc -c <"${ERROR_LOG}" 2>/dev/null | tr -d ' ')
	[[ "${TOTAL_LINES}" =~ ^[0-9]+$ ]] || TOTAL_LINES=0
	[[ "${TOTAL_BYTES}" =~ ^[0-9]+$ ]] || TOTAL_BYTES=0
	if (( CURSOR > TOTAL_LINES || TOTAL_BYTES < CURSOR_BYTES )); then
		CURSOR=0
	fi
	if (( TOTAL_LINES > CURSOR )); then
		FAILING_HOOKS=$(tail -n "$(( TOTAL_LINES - CURSOR ))" "${ERROR_LOG}" 2>/dev/null \
			| jq -r 'select(type == "object") | .hook // empty' 2>/dev/null | sort -u | tr '\n' ' ')
		FAILING_HOOKS="${FAILING_HOOKS% }"
		if [[ -n "${FAILING_HOOKS}" ]]; then
			HOOK_COUNT=$(wc -w <<< "${FAILING_HOOKS}" | tr -d ' ')
			ERROR_BLOCK=$(printf '\n[HOOK ERRORS] %s hook(s) logged errors since the last session start: %s. See %s.' \
				"${HOOK_COUNT}" "${FAILING_HOOKS}" "${ERROR_LOG}")
		fi
	fi
	if (( OWNS_SHARED_STATE )); then
		printf '%s %s\n' "${TOTAL_LINES}" "${TOTAL_BYTES}" >"${ERROR_CURSOR}" 2>/dev/null
	fi
fi

if [[ -n "${DATE_BLOCK}" ]]; then
	CONTEXT=$(printf '%s\nSession %s initialized. State directory: %s%s' "${DATE_BLOCK}" "${SESSION_ID}" "${STATE_DIR}" "${ERROR_BLOCK}" | jq -Rs .)
else
	CONTEXT=$(printf 'Session %s initialized. State directory: %s%s' "${SESSION_ID}" "${STATE_DIR}" "${ERROR_BLOCK}" | jq -Rs .)
fi

PLUGIN_ROOT_RESOLVE="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"

# Self-heal the plan registry before anything resolves against it: prune plans
# that are checkbox-complete or whose file is gone AND that no session is bound
# to. Without this a finished-but-never-cleared plan lingers in boulder.json
# forever (the write-path GC only runs on boulder_write) and leaks into session
# titles and downstream resolvers. Fail-soft: GC errors never block the hook.
python3 "${PLUGIN_ROOT_RESOLVE}/servers/tools/boulder_gc.py" "${HOOK_PROJECT_ROOT}" >/dev/null 2>&1 || true

# Emit sessionTitle only when the resolver shim binds this session to a plan AND
# that plan's active_plan file still exists. --strict: only an explicit binding
# resolves, never the sole-plan/most-recent fallback. An unbound session must
# never be titled with a plan it has no relationship to. Defensive: any resolve
# error, an unbound session, or a stale active_plan pointing at a deleted file,
# leaves SESSION_TITLE empty → key is omitted.
BOUND_PLAN=$(python3 "${PLUGIN_ROOT_RESOLVE}/servers/tools/boulder_resolve.py" "${SESSION_ID}" "${HOOK_PROJECT_ROOT}" --strict 2>/dev/null || echo '{}')
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

start_venv_sync
