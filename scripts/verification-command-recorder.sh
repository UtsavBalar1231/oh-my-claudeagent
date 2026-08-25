#!/usr/bin/env bash
# PostToolUse Bash hook. Records the most recent verification-runner invocation in a
# single-slot state file, so task-completed-verify.sh can gate on causal ordering — was
# evidence logged AFTER a verification actually ran — instead of guessing from a task's
# name. Always exits 0: this hook observes, it never decides.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

hook_is_disabled "verification-command-recorder" && exit 0
command -v jq >/dev/null 2>&1 || exit 0

COMMAND=$(jq -r '.tool_input.command // ""' <<< "${HOOK_INPUT}" 2>/dev/null)
[[ -n "${COMMAND}" ]] || exit 0

# A quoted span is a mention, not an invocation: `echo "npm test"` runs no test.
SCANNABLE=$(strip_paired_spans "${COMMAND}" '"')
SCANNABLE=$(strip_paired_spans "${SCANNABLE}" "'")

# The runner list is a heuristic with INVERTED polarity against the gate it feeds: a
# runner missing here records no slot, so the gate stays silent and a miss can never
# produce a false block. The list therefore stays tight, growing only when a real
# runner is observed going unrecorded. Anchoring on start-of-string or a shell
# separator keeps a mid-command flag value from reading as an invocation.
# `test` and `lint` take a suffix because the prefix already names the check and the
# suffix narrows it. `build` and `fmt` cannot: build-and-deploy ships, fmt rewrites.
VERIFICATION_RUNNER_RE='(^|[;&|(])[[:space:]]*(just[[:space:]]+((test|lint)(-[[:alnum:]_]+)*|ci|fmt-check|typecheck|build)|(npm|pnpm|yarn|bun)[[:space:]]+(test|run[[:space:]]+(test|lint|build))|pytest|cargo[[:space:]]+(test|build|check|clippy)|go[[:space:]]+(test|build|vet)|make[[:space:]]+(test|check|lint)|bats|tsc|ruff[[:space:]]+check|shellcheck|uv[[:space:]]+run[[:space:]][^;&|]*pytest)([^-[:alnum:]_]|$)'

[[ "${SCANNABLE}" =~ ${VERIFICATION_RUNNER_RE} ]] || exit 0

# The auto-mode classifier never sees tool results, so it cannot tell a verification run
# from any other shell call when it reviews the next one. This note is the supported
# channel for that one fact. It stays a static assertion about this call's origin: the
# field is model-facing input to a permission decision, so anything persuasive or
# instructional here would be a prompt-injection surface aimed at our own permissions.
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","classifierContext":"%s"}}\n' \
	"This Bash call ran one of this repository's own verification runners (test, lint, build, or typecheck)."

SLOT_FILE="${HOOK_STATE_DIR}/last-verification-command.json"
EVIDENCE_FILE=$(resolve_evidence_file "${HOOK_STATE_DIR}")

file_mtime() {
	local f="$1" m
	[[ -f "${f}" ]] || { printf '0\n'; return 0; }
	m=$(stat -c %Y "${f}" 2>/dev/null || stat -f %m "${f}" 2>/dev/null)
	[[ "${m}" =~ ^[0-9]+$ ]] || m=0
	printf '%s\n' "${m}"
}

# An unsatisfied slot — one with no evidence logged after it — outranks a newer
# verification. Overwriting would let a logged lint run shadow an earlier unlogged
# failing test run, the exact case this gate exists to catch.
if [[ -f "${SLOT_FILE}" ]]; then
	PREV_AT=$(jq_read "${SLOT_FILE}" '.at // 0')
	[[ "${PREV_AT}" =~ ^[0-9]+$ ]] || PREV_AT=0
	if ((PREV_AT > $(file_mtime "${EVIDENCE_FILE}"))); then
		exit 0
	fi
fi

# Display only, never load-bearing: the per-tool tool_response shape is undocumented,
# so a missing or oddly-named exit code must degrade to null rather than to a verdict.
EXIT_CODE=$(jq -c '(.tool_response // {}) | if type == "object" then (.exitCode // .exit_code // null) else null end' <<< "${HOOK_INPUT}" 2>/dev/null)
[[ -n "${EXIT_CODE}" ]] || EXIT_CODE=null

TMP=$(mktemp -p "${HOOK_STATE_DIR}" 2>/dev/null || mktemp "${HOOK_STATE_DIR}/.omca-slot.XXXXXX" 2>/dev/null) || exit 0
if jq -n --arg command "${COMMAND}" --argjson at "$(date +%s)" \
	--arg session_id "$(resolve_session_id)" --argjson exit_code "${EXIT_CODE}" \
	'{command: $command, at: $at, session_id: $session_id, exit_code: $exit_code}' > "${TMP}" 2>/dev/null; then
	mv "${TMP}" "${SLOT_FILE}" || log_hook_error "mv failed for last-verification-command.json" "$(basename "$0")"
else
	rm -f "${TMP}"
	log_hook_error "jq write failed for last-verification-command.json" "$(basename "$0")"
fi

exit 0
