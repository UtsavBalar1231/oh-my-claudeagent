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
# grep implementations, so negation is checked manually against the text
# immediately preceding each match offset.
CLAIM_RE='\b(done|complete|completed|finished|implemented|fixed|resolved|ready (to|for) (merge|review))\b'
NEG_RE="(not |haven'?t |isn'?t |doesn'?t |won'?t )\$"

LOWER_TEXT=$(tr '[:upper:]' '[:lower:]' <<< "${ASSISTANT_TEXT}")

has_completion_claim() {
	local offsets off _match prefix
	offsets=$(grep -aboE "${CLAIM_RE}" <<< "${LOWER_TEXT}")
	[[ -z "${offsets}" ]] && return 1
	while IFS=: read -r off _match; do
		prefix="${LOWER_TEXT:0:off}"
		if [[ "${prefix}" =~ ${NEG_RE} ]]; then
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
MARKER_ONLY='\b(describe|context|it|test|bench|suite)\.only\b'
MARKER_TODO='TODO: implement'                                       # explicit unfinished-implementation marker
MARKER_NOT_IMPL='throw new [A-Za-z]*Error\(["'"'"'].*not implemented' # stub throw for an unimplemented code path
MARKER_PATTERN="${MARKER_ONLY}|${MARKER_TODO}|${MARKER_NOT_IMPL}"

# A bats `@test "..."` line is a test name, not code: a suite that documents
# markers (this guard's own suite included) otherwise matches its description of
# what it looks for. Only the declaration line is exempt, so a real stub inside
# a test body still gets caught.
BATS_TEST_DECL='^[[:space:]]*@test[[:space:]]'

# In Markdown, a backtick-quoted occurrence and a fenced code block are the two
# forms that mean "I am naming this pattern", not "I left this stub": a
# comment-convention document cannot ban a marker without writing it down. Only
# those two forms are exempt, so a bare marker in Markdown prose stays a
# finding: genuine unfinished work does sometimes get recorded in a doc.
md_fenced_lines() {
	local line fence=0 n=0
	while IFS= read -r line || [[ -n "${line}" ]]; do
		n=$((n + 1))
		if [[ "${line}" =~ ^[[:space:]]*\`\`\` ]]; then
			fence=$((1 - fence))
			printf '%s\n' "${n}"
		elif [[ "${fence}" -eq 1 ]]; then
			printf '%s\n' "${n}"
		fi
	done < "$1"
}

# Remove every backtick-delimited span, shortest-match first, so a marker that
# survives was never quoted.
md_strip_inline_code() {
	local text="$1" head tail
	while [[ "${text}" == *\`*\`* ]]; do
		head="${text%%\`*}"
		tail="${text#*\`}"
		tail="${tail#*\`}"
		text="${head}${tail}"
	done
	printf '%s' "${text}"
}

md_line_is_documenting() {
	local lineno="$1" text="$2" fenced="$3"
	grep -qxF "${lineno}" <<< "${fenced}" && return 0
	local stripped
	stripped=$(md_strip_inline_code "${text}")
	grep -qE "${MARKER_PATTERN}" <<< "${stripped}" && return 1
	return 0
}

# 500 changed files — ~1ms scan each; above this the tree is machine-generated.
MAX_CHANGED_FILES=500

CHANGED_FILES=$(git -C "${HOOK_PROJECT_ROOT}" diff HEAD --name-only 2>/dev/null)
UNTRACKED_FILES=$(git -C "${HOOK_PROJECT_ROOT}" ls-files --others --exclude-standard 2>/dev/null)

FILE_COUNT=$(grep -c . <<< "${CHANGED_FILES}${UNTRACKED_FILES:+$'\n'}${UNTRACKED_FILES}")
if (( FILE_COUNT > MAX_CHANGED_FILES )); then
	echo "[DRIFT GUARD] ${FILE_COUNT} changed files exceeds the ${MAX_CHANGED_FILES}-file scan ceiling — skipping stub scan this Stop." >&2
	log_hook_info "changed-file count ${FILE_COUNT} exceeds ${MAX_CHANGED_FILES}, stub scan skipped" "$(basename "$0")"
	noop_exit
fi

FINDINGS=""

added_lines_stream() {
	git -C "${HOOK_PROJECT_ROOT}" diff HEAD --unified=0 2>/dev/null | awk '
		/^--- / { expect_header = 1; next }
		expect_header {
			expect_header = 0
			if ($0 ~ /^\+\+\+ /) {
				path = substr($0, 5)
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

MD_CACHE_FILE=""
MD_CACHE_LINES=""

record_candidate() {
	local file="$1" lineno="$2" text="$3"
	[[ -n "${file}" && -n "${lineno}" ]] || return 0
	grep -qE "${MARKER_PATTERN}" <<< "${text}" || return 0
	[[ "${text}" =~ ${BATS_TEST_DECL} ]] && return 0
	if [[ "${file}" == *.md ]]; then
		if [[ "${MD_CACHE_FILE}" != "${file}" ]]; then
			MD_CACHE_FILE="${file}"
			MD_CACHE_LINES=$(md_fenced_lines "${HOOK_PROJECT_ROOT}/${file}" 2>/dev/null)
		fi
		md_line_is_documenting "${lineno}" "${text}" "${MD_CACHE_LINES}" && return 0
	fi
	FINDINGS+="${file}:${lineno}  ${text}"$'\n'
	return 0
}

while IFS=$'\t' read -r file lineno text; do
	record_candidate "${file}" "${lineno}" "${text}"
done < <({ added_lines_stream; untracked_lines_stream; } | grep -E "${MARKER_PATTERN}")

if [[ -z "${FINDINGS}" ]]; then
	stop_blocks_reset
	noop_exit
fi

stop_block_allowed "drift-guard" || noop_exit

block_exit "[DRIFT GUARD] Completion claimed but stub markers remain on added/untracked lines:
${FINDINGS}
Resolve the stubs before claiming done, or stop claiming completion. Set OMCA_HOOK_DISABLE_DRIFT_GUARD=1 to bypass."
