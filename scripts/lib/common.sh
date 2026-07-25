#!/usr/bin/env bash
if [[ -z "${HOOK_INPUT+x}" ]]; then
	# 5s — generous margin over platform stdin write latency; long enough that no
	# observed hook payload has ever needed more, short enough to bound a stuck Stop.
	HOOK_INPUT=$(timeout 5 cat)
	if [[ $? -eq 124 ]]; then
		HOOK_INPUT=""
		HOOK_INPUT_TIMED_OUT=1
	else
		HOOK_INPUT_TIMED_OUT=0
	fi
fi
export HOOK_INPUT HOOK_INPUT_TIMED_OUT

HOOK_PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
HOOK_STATE_DIR="${HOOK_STATE_DIR:-${HOOK_PROJECT_ROOT}/.omca/state}"
HOOK_LOG_DIR="${HOOK_LOG_DIR:-${HOOK_PROJECT_ROOT}/.omca/logs}"
HOOK_MODE_STATE_SUFFIX="-state.json"

# 300s (5min): a clean window this long resets an error-counter key; prevents permanently tripped breakers.
ERROR_COUNT_DECAY_SECONDS=300

mkdir -p "${HOOK_STATE_DIR}" "${HOOK_LOG_DIR}" 2>/dev/null

log_hook_error() {
	local msg="$1"
	local hook_name="${2:-$(basename "$0")}"
	echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"hook\":\"${hook_name}\",\"error\":\"${msg}\"}" >>"${HOOK_LOG_DIR}/hook-errors.jsonl" 2>/dev/null
}

log_hook_info() {
	local msg="$1"
	local hook_name="${2:-$(basename "$0")}"
	echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"level\":\"info\",\"hook\":\"${hook_name}\",\"message\":\"${msg}\"}" >>"${HOOK_LOG_DIR}/hook-info.jsonl" 2>/dev/null
}

# Bump the error counter for <key> in error-counts.json: increments count,
# stamps last_failure_at, and prepends a truncated error summary to
# last_errors (newest first, capped at 3). Resets count + last_errors when
# the prior last_failure_at predates ERROR_COUNT_DECAY_SECONDS. Legacy bare-
# int values are read as {count: N, no timestamp/errors} and upgraded to the
# object shape on write. On any read/write failure the file is left
# untouched (atomic mktemp+mv) and "1" is printed as a safe fallback count.
# Usage: NEW_COUNT=$(error_count_bump <key> <error-summary>)
error_count_bump() {
	local key="$1"
	local error_summary="$2"
	local file="${HOOK_STATE_DIR}/error-counts.json"
	local now
	now=$(date +%s)
	error_summary=$(printf '%s' "${error_summary}" | tr '\n' ' ' | cut -c1-160)

	local base="{}"
	[[ -f "${file}" ]] && base=$(cat "${file}")

	local tmp
	tmp=$(mktemp) || { log_hook_error "mktemp failed for error-counts.json" "$(basename "$0")"; echo 1; return 0; }

	if printf '%s\n' "${base}" | jq \
		--arg key "${key}" --arg err "${error_summary}" \
		--argjson now "${now}" --argjson decay "${ERROR_COUNT_DECAY_SECONDS}" '
		def entry_of($k):
			(.[$k] // 0) as $v |
			if ($v | type) == "number" then {count: $v, last_failure_at: null, last_errors: []}
			else $v end;
		(entry_of($key)) as $e |
		(if ($e.last_failure_at != null) and (($now - $e.last_failure_at) > $decay)
			then {count: 0, last_errors: []}
			else {count: $e.count, last_errors: $e.last_errors} end) as $carried |
		.[$key] = {
			count: ($carried.count + 1),
			last_failure_at: $now,
			last_errors: ([$err] + $carried.last_errors)[0:3]
		}
	' >"${tmp}" 2>/dev/null; then
		mv "${tmp}" "${file}" || log_hook_error "mv failed for error-counts.json key=${key}" "$(basename "$0")"
		jq -r --arg key "${key}" '.[$key].count' "${file}" 2>/dev/null || echo 1
	else
		rm -f "${tmp}"
		log_hook_error "jq update failed for error-counts.json key=${key}" "$(basename "$0")"
		echo 1
	fi
}

section_header() {
	local title="$1"
	printf '\n─── %s ─────────────────────────────────────\n' "${title}"
}

mode_is_active() {
	local mode="$1"
	local state_dir="${2:-${HOOK_STATE_DIR}}"
	local state_file
	local status

	state_file="${state_dir}/${mode}${HOOK_MODE_STATE_SUFFIX}"
	if [[ ! -f "${state_file}" ]]; then
		return 1
	fi

	status=$(jq -r '.status // "inactive"' "${state_file}" 2>/dev/null || echo "")
	[[ "${status}" == "active" ]]
}

# Session path layout: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
# <encoded-cwd>: working directory with every non-alphanumeric char → "-"
# (e.g. /home/user/my-project → -home-user-my-project; platform-applied, OMCA reads only)
# Resolve session ID: tries CLAUDE_SESSION_ID env, HOOK_INPUT .session_id, session.json .sessionId.
# Prints empty string (returns 0) when none found.
resolve_session_id() {
	local sid
	for sid in "${CLAUDE_SESSION_ID:-}" \
	           "$(jq -r '.session_id // ""' <<< "${HOOK_INPUT:-{}}" 2>/dev/null)" \
	           "$(jq -r '.sessionId // ""' "${HOOK_STATE_DIR:-/nonexistent}/session.json" 2>/dev/null)"; do
		case "${sid}" in
			""|"null"|"unknown") continue ;;
			*) printf '%s\n' "${sid}"; return 0 ;;
		esac
	done
	return 0
}

# Read a JSON field with default. Returns default when file is absent or jq fails.
# Usage: jq_read <file> <jq-expr-with-default>
jq_read() {
	local file="$1"
	local expr="$2"
	if [[ ! -f "${file}" ]]; then
		jq -rn "${expr}" 2>/dev/null || true
		return 0
	fi
	jq -r "${expr}" "${file}" 2>/dev/null || true
}

# Emit hookSpecificOutput JSON with JSON-escaped message.
# Usage: emit_context <hookEventName> <plain-text-message>
emit_context() {
	local event_name="$1"
	local message="$2"
	local escaped
	escaped=$(printf '%s\n' "${message}" | jq -Rs .)
	printf '{"hookSpecificOutput": {"hookEventName": "%s", "additionalContext": %s}}\n' \
		"${event_name}" "${escaped}"
}

# Append a timing entry to hook-timing.jsonl. Write failures are silently suppressed.
# Usage: hook_timing_log <start-ns-timestamp>
hook_timing_log() {
	local start_ns="$1"
	local end_ns ms
	end_ns=$(date +%s%N 2>/dev/null || date +%s)
	ms=$(( (end_ns - start_ns) / 1000000 ))
	echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"hook\":\"$(basename "$0")\",\"ms\":${ms}}" \
		>> "${HOOK_LOG_DIR}/hook-timing.jsonl" 2>/dev/null
}

# active-modes.json path (relative to HOOK_STATE_DIR, set in common.sh)
ACTIVE_MODES_FILE="${HOOK_STATE_DIR}/active-modes.json"

# Returns 0 if the mode is already active in this session (suppress re-announce).
# Returns 1 if mode is absent, from a different session, or marker file is missing.
# Requires CURRENT_SESSION to be set by the caller (via resolve_session_id).
mode_already_announced() {
	local mode="$1"
	local stored_sid
	stored_sid=$(jq_read "${ACTIVE_MODES_FILE}" ".${mode}.session_id // \"\"")
	[[ -n "${stored_sid}" && "${stored_sid}" == "${CURRENT_SESSION}" ]]
}

# Write or update a mode entry in active-modes.json. Log and continue on failure.
# Requires CURRENT_SESSION to be set by the caller (via resolve_session_id).
mark_mode_announced() {
	local mode="$1"
	local now_epoch
	now_epoch=$(date +%s)
	local base="{}"
	if [[ -f "${ACTIVE_MODES_FILE}" ]]; then
		base=$(cat "${ACTIVE_MODES_FILE}")
	fi
	local tmp
	tmp=$(mktemp) || { log_hook_error "mktemp failed for active-modes.json" "$(basename "$0")"; return 0; }
	if printf '%s\n' "${base}" | jq \
		--arg mode "${mode}" \
		--argjson epoch "${now_epoch}" \
		--arg sid "${CURRENT_SESSION}" \
		'.[$mode] = {"detected_at": $epoch, "session_id": $sid}' > "${tmp}" 2>/dev/null; then
		mv "${tmp}" "${ACTIVE_MODES_FILE}" || log_hook_error "mv failed for active-modes.json" "$(basename "$0")"
	else
		rm -f "${tmp}"
		log_hook_error "jq update failed for active-modes.json mode=${mode}" "$(basename "$0")"
	fi
}

# Resolve the canonical evidence file path: <root>/.omca/evidence/verification-evidence.json.
# STATE_DIR is expected to be <root>/.omca/state.
# Usage: EVIDENCE_FILE=$(resolve_evidence_file "${STATE_DIR}")
resolve_evidence_file() {
	local state_dir="$1"
	local root
	root="${state_dir%/state}"
	printf '%s\n' "${root}/evidence/verification-evidence.json"
}

# Parse plan-file checkboxes with the same semantics as the Python CHECKBOX_RE
# (servers/tools/_boulder_core.py: `^- \[([ x])\] \d+\.`, case-insensitive on x)
# so bash callers and boulder_progress/statusline agree on the same counts.
# Emits four space-separated integers: unchecked checked total raw_unchecked.
#   unchecked:     numbered `- [ ] N.` lines
#   checked:       numbered `- [x] N.` / `- [X] N.` lines
#   total:         unchecked + checked
#   raw_unchecked: any `- [ ] ` line regardless of numbering; raw_unchecked >
#                    unchecked means malformed/unnumbered boxes are present
# Usage: read -r unchecked checked total raw_unchecked < <(count_plan_checkboxes "$plan_file")
count_plan_checkboxes() {
	local plan_file="$1"
	local unchecked checked raw_unchecked

	if [[ ! -f "${plan_file}" ]]; then
		printf '0 0 0 0\n'
		return 0
	fi

	unchecked=$(grep -cE '^- \[ \] [0-9]+\.' "${plan_file}" || true)
	checked=$(grep -cE '^- \[[xX]\] [0-9]+\.' "${plan_file}" || true)
	raw_unchecked=$(grep -cE '^- \[ \] ' "${plan_file}" || true)

	printf '%d %d %d %d\n' "${unchecked}" "${checked}" "$((unchecked + checked))" "${raw_unchecked}"
}

# Checks OMCA_DISABLED_HOOKS, a comma- and/or whitespace-separated list of
# hook basenames without the .sh suffix, for <name>. Returns 0 (disabled) on
# a match, 1 when unset/empty/no match. Unified kill switch for OMCA hooks.
# Usage: hook_is_disabled "final-verification-evidence" && exit 0
hook_is_disabled() {
	local name="$1"
	local list="${OMCA_DISABLED_HOOKS:-}"
	[[ -z "${list}" ]] && return 1
	local entry
	for entry in ${list//,/ }; do
		[[ "${entry}" == "${name}" ]] && return 0
	done
	return 1
}

# Block a Stop with <reason> and exit 0. `decision`+`reason` is the pair that
# prevents the stop; hookSpecificOutput.additionalContext is the platform's
# non-blocking alternative for the event, not a modifier, so emitting both
# would deliver the same text twice. A block is signalled by stdout alone, so
# the static fallback keeps a jq failure from turning a block into an allow.
# Usage: block_exit "<reason text>"
block_exit() {
	local reason="$1"
	local payload
	if payload=$(jq -n --arg reason "${reason}" '{"decision":"block","reason":$reason}' 2>/dev/null) \
		&& [[ -n "${payload}" ]]; then
		printf '%s\n' "${payload}"
	else
		log_hook_error "jq failed to encode Stop block reason, emitting static block payload" "$(basename "$0")"
		printf '%s\n' '{"decision":"block","reason":"An OMCA Stop gate blocked this stop but its reason text could not be encoded. See .omca/logs/hook-errors.jsonl."}'
	fi
	exit 0
}
