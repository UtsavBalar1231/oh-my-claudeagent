#!/usr/bin/env bash
# PostToolBatch hook (the event has no matcher support). Fires once per resolved
# batch carrying the whole tool_calls array, so the streak is per batch rather
# than per call: concurrent subagents can no longer interleave into one another's
# signature. Detects 3 consecutive identical batches and nudges toward changing
# approach.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

START_NS=$(epoch_ns)

hook_is_disabled "tool-loop-detector" && { hook_timing_log "${START_NS}"; exit 0; }

# Sorted keys (-S) so key-order differences never desync the signature.
# tool_response is deliberately excluded: it is the serialized result the model saw,
# which can differ between two attempts of the identical batch. Empty output means
# the payload was not valid JSON.
SIG_INPUT=$(jq -cS '[.tool_calls[]? | {tool_name: (.tool_name // ""), tool_input: (.tool_input // {})}]' <<< "${HOOK_INPUT}" 2>/dev/null)
if [[ -z "${SIG_INPUT}" ]]; then
	log_hook_error "malformed payload, unable to parse tool_calls" "$(basename "$0")"
	hook_timing_log "${START_NS}"
	exit 0
fi

# No calls to repeat: without this, repeated call-less payloads would share one
# signature and nudge about a loop that never happened.
if [[ "${SIG_INPUT}" == "[]" ]]; then
	hook_timing_log "${START_NS}"
	exit 0
fi

SIG=$(printf '%s' "${SIG_INPUT}" | sha256_of_stdin)
if [[ "${SIG}" == "${SHA256_UNAVAILABLE}" ]]; then
	hook_timing_log "${START_NS}"
	exit 0
fi
SIG="${SIG:0:16}"

STATE_FILE="${HOOK_STATE_DIR}/tool-loop-window.json"
# A repeat only counts as a loop within one user turn: prompt_id changing means the
# user spoke again, so an identical call is a fresh attempt, not the same streak.
# Absent (pre-2.1.196 clients, or before the first user input) reads as the empty
# string on both sides, which never triggers the reset.
PROMPT_ID=$(jq -r '.prompt_id // ""' <<< "${HOOK_INPUT}" 2>/dev/null)
PREV_SIG=""
PREV_COUNT=0
PREV_PROMPT_ID=""
if [[ -f "${STATE_FILE}" ]]; then
	read -r PREV_SIG PREV_COUNT PREV_PROMPT_ID < <(jq -r '[(.signature // ""), (.count // 0), (.prompt_id // "")] | @tsv' "${STATE_FILE}" 2>/dev/null)
	PREV_COUNT="${PREV_COUNT:-0}"
fi

if [[ "${PREV_SIG}" == "${SIG}" && "${PREV_PROMPT_ID}" == "${PROMPT_ID}" ]]; then
	NEW_COUNT=$((PREV_COUNT + 1))
else
	NEW_COUNT=1
fi

TMP=$(mktemp) || { log_hook_error "mktemp failed for tool-loop-window.json" "$(basename "$0")"; hook_timing_log "${START_NS}"; exit 0; }
if jq -n --arg sig "${SIG}" --argjson count "${NEW_COUNT}" --arg prompt_id "${PROMPT_ID}" '{signature: $sig, count: $count, prompt_id: $prompt_id}' > "${TMP}" 2>/dev/null; then
	mv "${TMP}" "${STATE_FILE}" || log_hook_error "mv failed for tool-loop-window.json" "$(basename "$0")"
else
	rm -f "${TMP}"
	log_hook_error "jq write failed for tool-loop-window.json" "$(basename "$0")"
fi

# 3: fires once per streak at the exact repeat count that signals a loop, not on
# every batch after (avoids re-nagging on the 4th, 5th, ... identical batch).
LOOP_FIRE_COUNT=3
if [[ "${NEW_COUNT}" -eq "${LOOP_FIRE_COUNT}" ]]; then
	emit_context "PostToolBatch" "This exact set of tool calls has now run 3 times in a row with identical arguments. Repetition is a loop signal, not persistence: change the approach, vary the input, or escalate."
fi

hook_timing_log "${START_NS}"
exit 0
