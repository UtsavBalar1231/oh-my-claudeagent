#!/usr/bin/env bash
# PermissionDenied hook — coach the model after auto-mode-classifier denies a tool call.
# Return hookSpecificOutput.retry: true for tools the model can rephrase (Bash); pass-through otherwise.
# No `set -euo pipefail` per hook conventions.

# shellcheck source=lib/common.sh
. "$(dirname "$0")/lib/common.sh"

# common.sh captures stdin into HOOK_INPUT on source; use it directly.
TOOL_NAME=$(printf '%s\n' "${HOOK_INPUT}" | jq -r '.tool_name // "<unknown>"')

case "${TOOL_NAME}" in
    Bash)
        printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}'
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
