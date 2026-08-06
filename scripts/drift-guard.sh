#!/bin/bash
# drift-guard.sh — blocks Stop when the assistant claims completion while the
# working tree (diff against HEAD + untracked files) still contains stub
# markers on added lines. Complements final-verification-evidence.sh: that gate
# proves "you showed passing evidence" (positive), this proves "you didn't
# leave stubs while claiming done" (negative).
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

noop_exit() {
	printf '{}\n'
	exit 0
}

if hook_is_disabled "drift-guard"; then
	echo "[DRIFT GUARD] Disabled via OMCA_DISABLED_HOOKS — skipping check." >&2
	noop_exit
fi

# Kill switch for emergency rollback
if [[ "${OMCA_HOOK_DISABLE_DRIFT_GUARD:-}" == "1" ]]; then
	echo "[DRIFT GUARD] Kill switch active (OMCA_HOOK_DISABLE_DRIFT_GUARD=1) — skipping check." >&2
	noop_exit
fi

# stdin read timed out: HOOK_INPUT is empty/unreliable, so neither the
# completion-claim text nor stop_hook_active can be trusted. Warn and allow —
# trapping the session on an unreadable signal is worse than an unenforced gate.
if [[ "${HOOK_INPUT_TIMED_OUT:-0}" -eq 1 ]]; then
	echo "[DRIFT GUARD] stdin read timed out — cannot evaluate stub drift this Stop. Allowing." >&2
	noop_exit
fi

if ! command -v jq >/dev/null 2>&1; then
	echo "[DRIFT GUARD] jq is unavailable — cannot evaluate stub drift this Stop. Allowing." >&2
	noop_exit
fi

# Re-entry backstop: if a prior Stop hook already forced a continuation this
# turn, don't re-run the (relatively expensive) git/text scan again.
STOP_HOOK_ACTIVE=$(jq -r '.stop_hook_active // false' <<< "${HOOK_INPUT}")
if [[ "${STOP_HOOK_ACTIVE}" == "true" ]]; then
	noop_exit
fi

# --- Extract the last assistant text. The Stop payload's
# `.last_assistant_message` is the authoritative source: the transcript file is
# written asynchronously and is not guaranteed to hold the final message of the
# turn yet. Tailing the transcript stays as a fallback for older clients that
# don't send the field.
extract_from_transcript() {
	local transcript="$1"
	local line text
	while IFS= read -r line; do
		text=$(jq -r '
			select(.type == "assistant" and (.message.role == "assistant"))
			| .message.content as $c
			| if ($c | type) == "string" then $c
			  else ($c // [] | map(select(.type == "text") | .text) | join("\n"))
			  end
		' <<< "${line}" 2>/dev/null)
		if [[ -n "${text}" && "${text}" != "null" ]]; then
			printf '%s' "${text}"
			return 0
		fi
	done < <(tac "${transcript}" 2>/dev/null)
	return 1
}

ASSISTANT_TEXT=$(jq -r '.last_assistant_message // ""' <<< "${HOOK_INPUT}" 2>/dev/null)
if [[ -z "${ASSISTANT_TEXT}" || "${ASSISTANT_TEXT}" == "null" ]]; then
	TRANSCRIPT_PATH=$(jq -r '.transcript_path // ""' <<< "${HOOK_INPUT}" 2>/dev/null)
	if [[ -n "${TRANSCRIPT_PATH}" && -f "${TRANSCRIPT_PATH}" ]]; then
		ASSISTANT_TEXT=$(extract_from_transcript "${TRANSCRIPT_PATH}")
	fi
fi

if [[ -z "${ASSISTANT_TEXT}" || "${ASSISTANT_TEXT}" == "null" ]]; then
	noop_exit
fi

# --- Completion-claim check: case-insensitive, excluding negated matches
# ("not done", "haven't finished", ...). ERE lookbehind isn't portable across
# grep implementations, so negation is checked manually, below.
CLAIM_RE='\b(done|complete|completed|finished|implemented|fixed|resolved|ready (to|for) (merge|review))\b'

# Scoped to the sentence the match sits in, not to the word immediately before it:
# "the tests are not passing, so nothing is fixed" negates across several words. The
# scope ends at the previous sentence boundary so an earlier sentence's negator cannot
# cancel a later genuine claim.
NEG_RE="(\b(not|no|nothing|none|never|un[a-z]+ished|incomplete|yet to|remains)\b|n'?t\b)"

LOWER_TEXT=$(tr '[:upper:]' '[:lower:]' <<< "${ASSISTANT_TEXT}")

# Backtick and double-quote spans quote someone else's words or name a literal, so a
# claim inside one is not this turn's claim. Single quotes are NOT stripped from prose:
# "haven't ... it's" would pair two apostrophes and blank the negators between them.
CLAIM_TEXT=$(strip_paired_spans "${LOWER_TEXT}" '`')
CLAIM_TEXT=$(strip_paired_spans "${CLAIM_TEXT}" '"')

has_completion_claim() {
	local offsets off _match prefix sentence
	offsets=$(grep -aboE "${CLAIM_RE}" <<< "${CLAIM_TEXT}")
	[[ -z "${offsets}" ]] && return 1
	while IFS=: read -r off _match; do
		prefix="${CLAIM_TEXT:0:off}"
		sentence="${prefix##*[.!?;:$'\n']}"
		if [[ "${sentence}" =~ ${NEG_RE} ]]; then
			continue
		fi
		return 0
	done <<< "${offsets}"
	return 1
}

if ! has_completion_claim; then
	noop_exit
fi

# --- Fail-open on any git error: not a repo, no commits/HEAD, detached, etc.
# A Stop hook that crashes or blocks spuriously is worse than one that misses.
if ! git -C "${HOOK_PROJECT_ROOT}" rev-parse --git-dir >/dev/null 2>&1; then
	noop_exit
fi
if ! git -C "${HOOK_PROJECT_ROOT}" rev-parse HEAD >/dev/null 2>&1; then
	noop_exit
fi

# Stub marker set — each with a derivation comment. Deliberately excludes
# `.skip` and "placeholder returns" (too broad / too many false positives).
MARKER_FOCUSED_TEST='\b(describe|context|it|test|bench|suite|specify|concurrent|serial|sequential)\.only\b'
MARKER_TODO='TODO: implement'                                       # explicit unfinished-implementation marker
MARKER_NOT_IMPL='throw new [A-Za-z]*Error\(["'"'"'].*not implemented' # stub throw for an unimplemented code path
MARKER_ANY_LANGUAGE="${MARKER_TODO}|${MARKER_NOT_IMPL}"
MARKER_PATTERN="${MARKER_FOCUSED_TEST}|${MARKER_ANY_LANGUAGE}"

FILE_WHERE_A_FOCUSED_TEST_CAN_RUN='\.(js|jsx|ts|tsx|mjs|cjs)$'

# A document cannot hold an executable stub, so a marker in one is always a mention.
FILE_THAT_IS_PROSE='\.(md|markdown|rst|txt|adoc)$'

# The markers safe to match against quote-stripped text. MARKER_NOT_IMPL is absent by
# construction: its pattern spans an opening quote, so stripping quoted spans would
# make it unmatchable forever. It is matched against the raw line instead.
quote_safe_markers_for() {
	if [[ "$1" =~ ${FILE_WHERE_A_FOCUSED_TEST_CAN_RUN} ]]; then
		printf '%s' "${MARKER_FOCUSED_TEST}|${MARKER_TODO}"
	else
		printf '%s' "${MARKER_TODO}"
	fi
}

# A bats `@test "..."` line is a test name, not code: a suite that documents
# markers (this guard's own suite included) otherwise matches its description of
# what it looks for. Only the declaration line is exempt, so a real stub inside
# a test body still gets caught.
BATS_TEST_DECL='^[[:space:]]*@test[[:space:]]'

# 500 changed files — ~1ms scan each; above this the tree is machine-generated.
MAX_CHANGED_FILES=500

GIT_DIFF_CONFIG=(-c diff.mnemonicPrefix=false -c diff.noprefix=false -c core.quotePath=false)

CHANGED_FILES=$(git -C "${HOOK_PROJECT_ROOT}" "${GIT_DIFF_CONFIG[@]}" diff --no-ext-diff HEAD --name-only 2>/dev/null)
UNTRACKED_FILES=$(git -C "${HOOK_PROJECT_ROOT}" -c core.quotePath=false ls-files --others --exclude-standard 2>/dev/null)

FILE_COUNT=$(grep -c . <<< "${CHANGED_FILES}${UNTRACKED_FILES:+$'\n'}${UNTRACKED_FILES}")
if (( FILE_COUNT > MAX_CHANGED_FILES )); then
	echo "[DRIFT GUARD] ${FILE_COUNT} changed files exceeds the ${MAX_CHANGED_FILES}-file scan ceiling — skipping stub scan this Stop." >&2
	log_hook_info "changed-file count ${FILE_COUNT} exceeds ${MAX_CHANGED_FILES}, stub scan skipped" "$(basename "$0")"
	noop_exit
fi

FINDINGS=""

added_lines_stream() {
	git -C "${HOOK_PROJECT_ROOT}" "${GIT_DIFF_CONFIG[@]}" diff --no-ext-diff HEAD --unified=0 2>/dev/null | awk '
		/^--- / { expect_header = 1; next }
		expect_header {
			expect_header = 0
			if ($0 ~ /^\+\+\+ /) {
				path = substr($0, 5)
				sub(/\t$/, "", path)
				sub(/^b\//, "", path)
				if (path == "/dev/null") path = ""
				next
			}
		}
		/^@@/ {
			split($0, parts, " ")
			plus = parts[3]
			sub(/^\+/, "", plus)
			split(plus, nums, ",")
			line = nums[1]
			next
		}
		/^\+/ {
			if (path != "") print path "\t" line "\t" substr($0, 2)
			line++
			next
		}
	'
}

untracked_lines_stream() {
	local file
	while IFS= read -r file; do
		[[ -z "${file}" ]] && continue
		[[ -f "${HOOK_PROJECT_ROOT}/${file}" ]] || continue
		grep -nE "${MARKER_PATTERN}" "${HOOK_PROJECT_ROOT}/${file}" 2>/dev/null \
			| awk -v f="${file}" '{ i = index($0, ":"); print f "\t" substr($0, 1, i - 1) "\t" substr($0, i + 1) }'
	done <<< "${UNTRACKED_FILES}"
}

record_candidate() {
	local file="$1" lineno="$2" text="$3"
	[[ -n "${file}" && -n "${lineno}" ]] || return 0
	[[ "${file}" =~ ${FILE_THAT_IS_PROSE} ]] && return 0
	[[ "${text}" =~ ${BATS_TEST_DECL} ]] && return 0

	if ! grep -qE "${MARKER_NOT_IMPL}" <<< "${text}"; then
		local stripped
		stripped=$(strip_paired_spans "${text}" "'")
		stripped=$(strip_paired_spans "${stripped}" '"')
		grep -qE "$(quote_safe_markers_for "${file}")" <<< "${stripped}" || return 0
	fi

	FINDINGS+="${file}:${lineno}  ${text}"$'\n'
	return 0
}

while IFS=$'\t' read -r file lineno text; do
	record_candidate "${file}" "${lineno}" "${text}"
done < <({ added_lines_stream; untracked_lines_stream; } | grep -E "${MARKER_PATTERN}")

if [[ -z "${FINDINGS}" ]]; then
	stop_blocks_reset "drift-guard"
	noop_exit
fi

stop_block_allowed "drift-guard" || noop_exit

block_exit "[DRIFT GUARD] Completion claimed but stub markers remain on added/untracked lines:
${FINDINGS}
Resolve the stubs before claiming done, or stop claiming completion. Set OMCA_HOOK_DISABLE_DRIFT_GUARD=1 to bypass."
