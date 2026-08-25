#!/bin/bash
# StopFailure fires INSTEAD of Stop when a turn dies on an API error, so none of the three
# Stop gates observes it, and the error class recorded here is the only trace that a plan
# run was abandoned mid-flight rather than finished. The event has no decision control and
# its output and exit code are discarded, so this handler observes and never blocks.
source "$(dirname "$0")/lib/common.sh"

hook_is_disabled "stop-failure-log" && exit 0

ERROR=$(jq -r '.error // ""' <<<"${HOOK_INPUT}")
[[ -n "${ERROR}" ]] || exit 0

DETAILS=$(jq -r '.error_details // ""' <<<"${HOOK_INPUT}")

log_hook_info "turn ended in API error: ${ERROR}${DETAILS:+ (${DETAILS})}"
exit 0
