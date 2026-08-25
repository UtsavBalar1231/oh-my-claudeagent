#!/usr/bin/env bash
if [[ -z "${HOOK_INPUT+x}" ]]; then
	# 5s — generous margin over platform stdin write latency; long enough that no
	# observed hook payload has ever needed more, short enough to bound a stuck Stop.
	HOOK_INPUT_TIMED_OUT=0
	_hook_read_rc=0
	if command -v timeout >/dev/null 2>&1; then
		HOOK_INPUT=$(timeout 5 cat)
		_hook_read_rc=$?
	elif command -v gtimeout >/dev/null 2>&1; then
		HOOK_INPUT=$(gtimeout 5 cat)
		_hook_read_rc=$?
	else
		HOOK_INPUT=$(cat)
	fi
	if [[ ${_hook_read_rc} -eq 124 ]]; then
		HOOK_INPUT=""
		HOOK_INPUT_TIMED_OUT=1
	elif [[ -z "${HOOK_INPUT//[[:space:]]/}" ]] || ! jq -e . >/dev/null 2>&1 <<<"${HOOK_INPUT}"; then
		HOOK_INPUT_TIMED_OUT=1
	fi
	unset _hook_read_rc
fi
export HOOK_INPUT HOOK_INPUT_TIMED_OUT

HOOK_PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
HOOK_STATE_DIR="${HOOK_STATE_DIR:-${HOOK_PROJECT_ROOT}/.omca/state}"
HOOK_LOG_DIR="${HOOK_LOG_DIR:-${HOOK_PROJECT_ROOT}/.omca/logs}"
HOOK_MODE_STATE_SUFFIX="-state.json"

# 300s (5min): a clean window this long resets an error-counter key; prevents permanently tripped breakers.
ERROR_COUNT_DECAY_SECONDS=300

mkdir -p "${HOOK_STATE_DIR}" "${HOOK_LOG_DIR}" 2>/dev/null

# Messages carry caller-supplied text: file paths, quoted findings, error
# output. jq builds the record so a quote or backslash in that text cannot
# break the line, which shell interpolation could not guarantee.
log_hook_error() {
	local msg="$1"
	local hook_name="${2:-$(basename "$0")}"
	jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg hook "${hook_name}" --arg msg "${msg}" \
		'{timestamp: $ts, hook: $hook, error: $msg}' >>"${HOOK_LOG_DIR}/hook-errors.jsonl" 2>/dev/null
}

log_hook_info() {
	local msg="$1"
	local hook_name="${2:-$(basename "$0")}"
	jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg hook "${hook_name}" --arg msg "${msg}" \
		'{timestamp: $ts, level: "info", hook: $hook, message: $msg}' >>"${HOOK_LOG_DIR}/hook-info.jsonl" 2>/dev/null
}

SHA256_UNAVAILABLE="no-digest"

sha256_of_stdin() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 | cut -d' ' -f1
	else
		cat >/dev/null
		printf '%s\n' "${SHA256_UNAVAILABLE}"
	fi
}

epoch_ns() {
	local ns
	ns=$(date +%s%N 2>/dev/null)
	if [[ "${ns}" =~ ^[0-9]+$ ]]; then
		printf '%s\n' "${ns}"
	else
		printf '%s000000000\n' "$(date +%s)"
	fi
}

STATE_LOCK_SPIN_ATTEMPTS=50
STATE_LOCK_SPIN_SLEEP_SECONDS=0.1
STATE_LOCK_ABANDONED_AFTER_SECONDS=60

reclaim_state_lockdir_if_abandoned() {
	local lockdir="$1"
	local now mtime
	now=$(date +%s)
	mtime=$(stat -c %Y "${lockdir}" 2>/dev/null || stat -f %m "${lockdir}" 2>/dev/null)
	[[ "${mtime}" =~ ^[0-9]+$ ]] || return 1
	(( now - mtime > STATE_LOCK_ABANDONED_AFTER_SECONDS )) || return 1
	rmdir "${lockdir}" 2>/dev/null
}

acquire_state_lockdir_or_give_up() {
	local lockdir="$1"
	local attempt
	for (( attempt = 0; attempt < STATE_LOCK_SPIN_ATTEMPTS; attempt++ )); do
		mkdir "${lockdir}" 2>/dev/null && return 0
		reclaim_state_lockdir_if_abandoned "${lockdir}" && continue
		sleep "${STATE_LOCK_SPIN_SLEEP_SECONDS}"
	done
	return 1
}

run_body_holding_state_lockdir() {
	local lockdir="$1"
	shift
	(
		STATE_LOCKDIR="${lockdir}"
		trap 'rmdir "${STATE_LOCKDIR}" 2>/dev/null' EXIT INT TERM HUP
		"$@"
	)
}

with_state_lock() {
	local file="$1"
	shift
	local dir
	dir=$(dirname "${file}")

	if [[ ! -d "${dir}" || ! -w "${dir}" ]]; then
		"$@"
		return $?
	fi

	if command -v flock >/dev/null 2>&1; then
		(
			flock -w 5 200 || log_hook_error "flock wait timed out on $(basename "${file}"), proceeding unlocked" "$(basename "$0")"
			"$@"
		) 200>"${file}.lock"
		return $?
	fi

	if ! acquire_state_lockdir_or_give_up "${file}.lockdir"; then
		log_hook_error "lock spin exhausted on $(basename "${file}"), proceeding unlocked" "$(basename "$0")"
		"$@"
		return $?
	fi
	run_body_holding_state_lockdir "${file}.lockdir" "$@"
}

json_base() {
	local base
	base=$(jq -c . "$1" 2>/dev/null) || base='{}'
	[[ -z "${base}" || "${base}" == "null" ]] && base='{}'
	printf '%s\n' "${base}"
}

json_rmw() {
	local file="$1"
	local filter="$2"
	shift 2
	local dir tmp
	dir=$(dirname "${file}")
	mkdir -p "${dir}" 2>/dev/null
	tmp=$(mktemp -p "${dir}" 2>/dev/null || mktemp "${dir}/.omca-rmw.XXXXXX" 2>/dev/null) || return 1
	if json_base "${file}" | jq "$@" "${filter}" >"${tmp}" 2>/dev/null && [[ -s "${tmp}" ]]; then
		mv "${tmp}" "${file}" 2>/dev/null && return 0
	fi
	rm -f "${tmp}"
	return 1
}

# Usage: NEW_COUNT=$(error_count_bump <key> <error-summary>)
error_count_bump() {
	local key="$1"
	local error_summary="$2"
	local file="${HOOK_STATE_DIR}/error-counts.json"
	error_summary=$(printf '%s' "${error_summary}" | tr '\n' ' ' | cut -c1-160)
	with_state_lock "${file}" error_count_bump_body "${file}" "${key}" "${error_summary}"
}

error_count_bump_body() {
	local file="$1" key="$2" error_summary="$3"
	local now
	now=$(date +%s)

	# shellcheck disable=SC2016 # jq filter: $vars are jq bindings passed via --arg, not shell
	if json_rmw "${file}" '
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
	' --arg key "${key}" --arg err "${error_summary}" \
		--argjson now "${now}" --argjson decay "${ERROR_COUNT_DECAY_SECONDS}"; then
		jq -r --arg key "${key}" '.[$key].count' "${file}" 2>/dev/null || echo 1
	else
		log_hook_error "update failed for error-counts.json key=${key}" "$(basename "$0")"
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
	end_ns=$(epoch_ns)
	[[ "${start_ns}" =~ ^[0-9]+$ ]] || return 0
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
	# shellcheck disable=SC2016 # jq filter: $vars are jq bindings passed via --arg, not shell
	with_state_lock "${ACTIVE_MODES_FILE}" \
		json_rmw "${ACTIVE_MODES_FILE}" '.[$mode] = {"detected_at": $epoch, "session_id": $sid}' \
		--arg mode "${mode}" \
		--argjson epoch "$(date +%s)" \
		--arg sid "${CURRENT_SESSION}" \
		|| log_hook_error "update failed for active-modes.json mode=${mode}" "$(basename "$0")"
	return 0
}

HARD_CAP_BLOCKS=5
STOP_BLOCKS_FILE="${HOOK_STATE_DIR}/stop-blocks.json"

stop_block_allowed() {
	local gate="$1"
	[[ -n "${gate}" ]] || return 1
	command -v jq >/dev/null 2>&1 || return 1
	[[ -d "${HOOK_STATE_DIR}" && -w "${HOOK_STATE_DIR}" ]] || return 1

	local count=0
	if [[ -f "${STOP_BLOCKS_FILE}" ]]; then
		if ! count=$(jq -er --arg g "${gate}" '(.[$g] // 0) | numbers // 0' "${STOP_BLOCKS_FILE}" 2>/dev/null); then
			printf '{}\n' >"${STOP_BLOCKS_FILE}" 2>/dev/null
			return 1
		fi
		[[ "${count}" =~ ^[0-9]+$ ]] || count=0
	fi
	((count < HARD_CAP_BLOCKS)) || return 1

	# shellcheck disable=SC2016 # jq filter: $vars are jq bindings passed via --arg, not shell
	with_state_lock "${STOP_BLOCKS_FILE}" \
		json_rmw "${STOP_BLOCKS_FILE}" '.[$g] = ((.[$g] // 0 | numbers // 0) + 1)' --arg g "${gate}" \
		|| return 1
	return 0
}

stop_blocks_reset() {
	local gate="$1"
	if [[ -z "${gate}" ]]; then
		rm -f "${STOP_BLOCKS_FILE}" 2>/dev/null
		return 0
	fi
	[[ -f "${STOP_BLOCKS_FILE}" ]] || return 0
	# shellcheck disable=SC2016 # jq filter: $vars are jq bindings passed via --arg, not shell
	with_state_lock "${STOP_BLOCKS_FILE}" \
		json_rmw "${STOP_BLOCKS_FILE}" 'del(.[$g])' --arg g "${gate}" \
		|| log_hook_error "stop-blocks reset failed for gate=${gate}" "$(basename "$0")"
	return 0
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
# Usage: hook_is_disabled "final-verification-evidence" && exit 0
hook_is_disabled() {
	local name="$1"
	local list="${OMCA_DISABLED_HOOKS:-}"
	[[ -z "${list}" ]] && return 1
	local padded=" ${list//,/ } "
	[[ "${padded}" == *" all "* || "${padded}" == *" * "* ]] && return 0
	local entry
	for entry in ${list//,/ }; do
		[[ "${entry}" == "${name}" ]] && return 0
	done
	return 1
}

# Blank out the characters that open a command position when they occur inside a
# quoted span, so a Bash guard scanning for a command-position pattern cannot read
# a literal mention as a real invocation. `; & | ( )` plus newline and CR become
# `_`; inside a single-quoted span `$` and backtick lose their meaning too, so they
# are blanked as well.
# This is a substitute for a tokenizer, not one: an unbalanced quote makes the rest
# of the string read as quoted, which under-denies rather than over-denies.
# Arguments:
#   $1 - the raw command string
# Outputs:
#   The neutralized string on STDOUT, no trailing newline.
neutralize_quoted_positions() {
	local s="$1" out="" quote="" ch i
	for ((i = 0; i < ${#s}; i++)); do
		ch="${s:i:1}"
		if [[ -n "${quote}" ]]; then
			if [[ "${ch}" == "${quote}" ]]; then
				quote=""
			elif [[ "${ch}" == [\;\&\|\(\)] || "${ch}" == $'\n' || "${ch}" == $'\r' ]]; then
				ch="_"
			elif [[ "${quote}" == "'" && ("${ch}" == '$' || "${ch}" == '`') ]]; then
				ch="_"
			fi
		elif [[ "${ch}" == "'" || "${ch}" == '"' ]]; then
			quote="${ch}"
		fi
		out+="${ch}"
	done
	printf '%s' "${out}"
}

# Blank the contents of every <delim>-delimited span whose closing delimiter falls on
# the SAME line, leaving the delimiters themselves in place, so a scanner reading the
# result sees a mention as an empty span rather than as text it can match. This is the
# opposite transform from neutralize_quoted_positions, which preserves quoted text and
# only defuses the metacharacters inside it.
# A delimiter with no partner before the next newline is literal (`don't`): it is
# emitted unchanged, so an apostrophe can never swallow the rest of its line.
# Arguments:
#   $1 - the raw text
#   $2 - a single-character delimiter
# Outputs:
#   The stripped text on STDOUT, no trailing newline.
strip_paired_spans() {
	local s="$1" delim="$2" out="" i ch rest line_rest before_close
	local n=${#s}
	for ((i = 0; i < n; i++)); do
		ch="${s:i:1}"
		if [[ "${ch}" != "${delim}" ]]; then
			out+="${ch}"
			continue
		fi
		rest="${s:i+1}"
		line_rest="${rest%%$'\n'*}"
		before_close="${line_rest%%"${delim}"*}"
		if [[ "${before_close}" == "${line_rest}" ]]; then
			out+="${ch}"
			continue
		fi
		out+="${delim}${delim}"
		i=$((i + ${#before_close} + 1))
	done
	printf '%s' "${out}"
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
		local gate
		gate=$(basename "$0" .sh | tr -cd '[:alnum:]._-')
		printf '{"decision":"block","reason":"The OMCA Stop gate %s blocked this stop but its reason text could not be encoded. See .omca/logs/hook-errors.jsonl. To bypass, set OMCA_DISABLED_HOOKS=%s (or OMCA_DISABLED_HOOKS=all) and stop again."}\n' \
			"${gate}" "${gate}"
	fi
	exit 0
}

# Translate a denied `grep` invocation into the equivalent `rg` one, so a gate can
# rewrite the call instead of spending a deny-and-retry round trip on it.
# The translated set is deliberately tiny: a deny costs one retry, a wrong rewrite
# silently runs a different command than the caller asked for. Refused shapes are
# anything but a single simple command (the operand tail is copied through byte for
# byte, so a separator, redirect, substitution, or expansion could move meaning
# outside it), a command word other than exactly `grep`, and any flag that is not a
# clustered short flag spelled identically by rg. `r`/`R` are dropped since rg
# recurses by default.
# Recursive rg skips gitignored, hidden, and binary files where recursive grep does
# not; that divergence is accepted because rg is already the search posture this
# plugin tells callers to use. An explicitly named file is searched by rg regardless
# of ignore rules, so the single-file form is exact.
# Arguments:
#   $1 - the raw command string
# Outputs:
#   The rewritten `rg ...` command on STDOUT, no trailing newline.
# Returns:
#   0 when translated, 1 when the caller must keep denying.
grep_to_rg() {
	local cmd="$1" rest tok cluster keep flags="" i ch
	local -a tail_tokens
	local UNSAFE_SHELL_CHARS=$'[;&|<>`()$\n\r]'
	[[ "${cmd}" =~ ${UNSAFE_SHELL_CHARS} ]] && return 1
	rest="${cmd#"${cmd%%[![:space:]]*}"}"
	[[ "${rest}" == grep[[:space:]]* ]] || return 1
	rest="${rest#grep}"
	while true; do
		rest="${rest#"${rest%%[![:space:]]*}"}"
		[[ -n "${rest}" ]] || return 1
		tok="${rest%%[[:space:]]*}"
		[[ "${tok}" == -* ]] || break
		[[ "${tok}" =~ ^-[a-zA-Z]+$ ]] || return 1
		cluster="${tok#-}"
		keep=""
		for ((i = 0; i < ${#cluster}; i++)); do
			ch="${cluster:i:1}"
			case "${ch}" in
			r | R) ;;
			n | i | w | v | c | l | F | H | h) keep+="${ch}" ;;
			*) return 1 ;;
			esac
		done
		[[ -n "${keep}" ]] && flags+=" -${keep}"
		rest="${rest#"${tok}"}"
	done
	# `read -ra` splits without globbing, so a `*.py` operand is not expanded here.
	read -ra tail_tokens <<< "${rest}"
	for tok in "${tail_tokens[@]}"; do
		tok="${tok#[\'\"]}"
		[[ "${tok}" == -* ]] && return 1
	done
	printf 'rg%s %s' "${flags}" "${rest}"
}
