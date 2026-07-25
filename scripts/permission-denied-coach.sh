#!/usr/bin/env bash
# PermissionDenied hook — coach the model after auto-mode-classifier denies a tool call.
# Return hookSpecificOutput.retry: true for tools the model can rephrase (Bash); pass-through otherwise.
# No `set -euo pipefail` per hook conventions.

# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"

# common.sh captures stdin into HOOK_INPUT on source; use it directly.
# Extract denied tool + denial reason via inline jq (jq_read helper reads file paths, not stdin).
TOOL_NAME=$(printf '%s\n' "${HOOK_INPUT}" | jq -r '.tool_name // "<unknown>"')
REASON=$(printf '%s\n' "${HOOK_INPUT}" | jq -r '.reason // .denial_reason // .message // ""')

# The denial reason is not matchable by substring: it is the fixed text
# "Blocked by classifier" in most sessions, and a classifier-written
# explanation in the rest. Neither shape is under this hook's control, so the
# coach keys on the denied tool and forwards whatever reason arrived as a hint.
# The model retries with adjusted arguments after seeing the additionalContext.
case "${TOOL_NAME}" in
    Bash)
        # Surface the denied command and suggest a safer phrasing.
        COACH="The Bash command was denied by the auto-mode classifier (reason: ${REASON:-none reported}). Try one of: \
(a) split the pipeline into separate steps, \
(b) use a safer flag (e.g. read-only equivalents), \
(c) ask the user to add a permission allowlist entry. \
If the reason names a destination or an intent, address that specifically. \
Do NOT retry the same command verbatim."
        # `retry` must live inside hookSpecificOutput; a top-level retry is ignored.
        jq -nc --arg c "${COACH}" '{hookSpecificOutput: {hookEventName: "PermissionDenied", retry: true, additionalContext: $c}}'
        exit 0
        ;;
    *)
        # Pass-through — no retry hint.
        exit 0
        ;;
esac
