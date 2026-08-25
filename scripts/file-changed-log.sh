#!/bin/bash
# FileChanged observer for the two state files OMCA treats as authoritative: the
# evidence ledger and the plan registry. write-guard.sh denies Write/Edit against
# them, but that guard is keyed on tool name, so a Bash redirect or a `python -c`
# rewrites either file without tripping it. FileChanged fires off a filesystem
# watcher regardless of what wrote the file, which closes the observation gap.
# It cannot close the enforcement gap: the event has no decision control and
# cannot block the write. Detection only.
#
# The matcher value is resolved as a cwd-relative watch path AND matched against
# the changed file's basename to pick hook groups. Our targets live in
# subdirectories, so only the basename register can select them; the watch half
# comes from session-init.sh returning both absolute paths in SessionStart
# `watchPaths`. Dropping that emission silently disables this handler, because
# the matcher alone watches nothing that exists. Measured on client 2.1.245.

source "$(dirname "$0")/lib/common.sh"

hook_is_disabled "file-changed-log" && exit 0

[[ "${HOOK_INPUT_TIMED_OUT:-0}" -eq 1 ]] && exit 0

FILE_PATH=$(jq -r '.file_path // ""' <<<"${HOOK_INPUT}")
[[ -z "${FILE_PATH}" ]] && exit 0

case "${FILE_PATH}" in
*/.omca/evidence/verification-evidence.json | */.omca/state/boulder.json) ;;
*) exit 0 ;;
esac

CHANGE_EVENT=$(jq -r '.event // "change"' <<<"${HOOK_INPUT}")

log_hook_info "out-of-band ${CHANGE_EVENT} to ${FILE_PATH}" "$(basename "$0")"
exit 0
