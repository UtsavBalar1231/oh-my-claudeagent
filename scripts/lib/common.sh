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

mkdir -p "${HOOK_STATE_DIR}" "${HOOK_LOG_DIR}" 2>/dev/null

epoch_ns() {
	local ns
	ns=$(date +%s%N 2>/dev/null)
	if [[ "${ns}" =~ ^[0-9]+$ ]]; then
		printf '%s\n' "${ns}"
	else
		printf '%s000000000\n' "$(date +%s)"
	fi
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
