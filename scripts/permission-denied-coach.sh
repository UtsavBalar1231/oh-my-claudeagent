#!/usr/bin/env bash
# PermissionDenied hook — coach the model after auto-mode-classifier denies a tool call.
# Return {retry: true} for known-recoverable patterns; pass-through otherwise.
# No `set -euo pipefail` per hook conventions.

# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"

# common.sh captures stdin into HOOK_INPUT on source; use it directly.
# Extract denied tool + denial reason via inline jq (jq_read helper reads file paths, not stdin).
TOOL_NAME=$(printf '%s\n' "${HOOK_INPUT}" | jq -r '.tool_name // "<unknown>"')
REASON=$(printf '%s\n' "${HOOK_INPUT}" | jq -r '.reason // .denial_reason // .message // ""')

# Patterns we can coach the model out of.
# The model retries with adjusted arguments after seeing the additionalContext.
case "${TOOL_NAME}:${REASON}" in
    Bash:*"not in allowlist"*|Bash:*"requires permission"*)
        # Surface the denied command and suggest a safer phrasing.
        COACH="The Bash command was denied by the auto-mode classifier. Try one of: \
(a) split the pipeline into separate steps, \
(b) use a safer flag (e.g. read-only equivalents), \
(c) ask the user to add a permission allowlist entry. \
Do NOT retry the same command verbatim."
        jq -nc --arg c "${COACH}" '{retry: true, hookSpecificOutput: {hookEventName: "PermissionDenied", additionalContext: $c}}'
        exit 0
        ;;
    *)
        # Pass-through — no retry hint.
        exit 0
        ;;
esac
