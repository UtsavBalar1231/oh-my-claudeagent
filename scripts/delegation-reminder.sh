#!/bin/bash
# delegation-reminder.sh: one-shot nudge when the main session runs direct work
# tools repeatedly instead of delegating to specialist agents.
#
# Intended registration (a later serial task wires this into hooks.json):
#   PostToolUse, matcher: Edit|Write|Bash: counts direct work-tool calls.
#   PostToolUse, matcher: Agent: resets the counter (a delegation happened).
# Both matchers point at this same script; behavior branches on .tool_name below.
#
# Rationale: a batch-level delegation reminder was removed in the native-leaning
# minimize refactor. This differs: it is per-call, fires at most once per session
# (not per batch), and is kill-switchable. Fresh audit evidence showed the
# main-session-does-leaf-work failure mode persists: static prompt pressure in
# CLAUDE.md/output-styles alone has not closed it, so this fires at the
# behavioral moment instead.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

hook_is_disabled "delegation-reminder" && exit 0

# Main-session detection mirrors executor-grep-deny.sh EXACTLY: .subagent_type
# is the native payload field for "this call happened inside a subagent".
# agent_id is a SubagentStart-only field and must NOT be used here.
SUBAGENT_TYPE=$(jq -r '.subagent_type // ""' <<< "${HOOK_INPUT}")
if [[ -n "${SUBAGENT_TYPE}" && "${SUBAGENT_TYPE}" != "null" ]]; then
	exit 0
fi

COUNTER_FILE="${HOOK_STATE_DIR}/delegation-counter.json"

write_counter() {
	local direct_calls="$1"
	local silenced="$2"
	local tmp
	tmp=$(mktemp) || { log_hook_error "mktemp failed for delegation-counter.json" "$(basename "$0")"; return 0; }
	if jq -n --argjson direct_calls "${direct_calls}" --argjson silenced "${silenced}" \
		'{"direct_calls": $direct_calls, "silenced": $silenced}' > "${tmp}" 2>/dev/null; then
		mv "${tmp}" "${COUNTER_FILE}" || log_hook_error "mv failed for delegation-counter.json" "$(basename "$0")"
	else
		rm -f "${tmp}"
		log_hook_error "jq write failed for delegation-counter.json" "$(basename "$0")"
	fi
}

TOOL_NAME=$(jq -r '.tool_name // ""' <<< "${HOOK_INPUT}")

# An Agent call is a delegation: reset the counter and silence future reminders
# this session. Only reachable if this script is ALSO registered on
# PostToolUse Agent: the Edit|Write|Bash matcher never sees tool_name=="Agent".
if [[ "${TOOL_NAME}" == "Agent" ]]; then
	write_counter 0 true
	exit 0
fi

DIRECT_CALLS=$(jq_read "${COUNTER_FILE}" '.direct_calls // 0')
SILENCED=$(jq_read "${COUNTER_FILE}" '.silenced // false')
[[ "${DIRECT_CALLS}" =~ ^[0-9]+$ ]] || DIRECT_CALLS=0

if [[ "${SILENCED}" == "true" ]]; then
	exit 0
fi

DIRECT_CALLS=$((DIRECT_CALLS + 1))

# 3: three direct work-tool calls with zero delegation in between is the
# threshold observed in audit evidence where main-session leaf work recurs.
if [[ "${DIRECT_CALLS}" -ge 3 ]]; then
	write_counter "${DIRECT_CALLS}" true
	MSG="[DELEGATION REMINDER] Three direct work-tool calls have run this session with no delegation.
Specialist agents exist for this: executor (scoped implementation), explore (local search),
librarian (external research), hephaestus (build fixes). Consider delegating scoped work, e.g.:
Agent(subagent_type=\"oh-my-claudeagent:executor\", prompt=\"<scoped task>\")
This is a one-shot nudge and will not repeat this session."
	emit_context "PostToolUse" "${MSG}"
	exit 0
fi

write_counter "${DIRECT_CALLS}" false
exit 0
