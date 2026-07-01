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

# Re-entry backstop: if a prior Stop hook already forced a continuation this
# turn, don't re-run the (relatively expensive) git/text scan again.
STOP_HOOK_ACTIVE=$(jq -r '.stop_hook_active // false' <<< "${HOOK_INPUT}")
if [[ "${STOP_HOOK_ACTIVE}" == "true" ]]; then
	noop_exit
fi

# --- Extract the last assistant text: inline `.messages` array, or fall back
# to tailing `.transcript_path` (Task 0 probe: Stop payload confirmed to carry
# transcript_path; `.messages` is not confirmed but read defensively first).
extract_from_messages() {
	jq -r '
		(.messages // empty) as $msgs
		| ($msgs | map(select(.role == "assistant")) | last) as $last
		| if $last == null then empty
		  else
		    ($last.content) as $c
		    | if ($c | type) == "string" then $c
		      else ($c // [] | map(select(.type == "text") | .text) | join("\n"))
		      end
		  end
	' <<< "${HOOK_INPUT}" 2>/dev/null
}

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

ASSISTANT_TEXT=$(extract_from_messages)
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
MARKER_ONLY='\.only\b'                                              # focused test left in (it.only(, describe.only()
MARKER_TODO='TODO: implement'                                       # explicit unfinished-implementation marker
MARKER_NOT_IMPL='throw new [A-Za-z]*Error\(["'"'"'].*not implemented' # stub throw for an unimplemented code path
MARKER_PATTERN="${MARKER_ONLY}|${MARKER_TODO}|${MARKER_NOT_IMPL}"

# New-file-relative added line numbers for a tracked file's unstaged+staged
# diff against HEAD. Only `+` lines advance the new-line counter; hunk headers
# (@@ -a,b +c,d @@) reset it to c per hunk.
get_added_lines() {
	local file="$1"
	git -C "${HOOK_PROJECT_ROOT}" diff HEAD --unified=0 -- "${file}" 2>/dev/null | awk '
		/^@@/ {
			split($0, parts, " ")
			plus = parts[3]
			sub(/^\+/, "", plus)
			split(plus, nums, ",")
			line = nums[1]
			next
		}
		/^\+\+\+/ { next }
		/^\+/ { print line; line++; next }
	'
}

FINDINGS=""

scan_file() {
	local file="$1"
	local untracked="$2"
	local abs_path="${HOOK_PROJECT_ROOT}/${file}"
	[[ -f "${abs_path}" ]] || return 0

	local added_lines=""
	if [[ "${untracked}" != "true" ]]; then
		added_lines=$(get_added_lines "${file}")
		[[ -z "${added_lines}" ]] && return 0
	fi

	local lineno rest
	while IFS=: read -r lineno rest; do
		[[ -z "${lineno}" ]] && continue
		if [[ "${untracked}" == "true" ]] || grep -qxF "${lineno}" <<< "${added_lines}"; then
			FINDINGS+="${file}:${lineno}  ${rest}"$'\n'
		fi
	done < <(grep -InE "${MARKER_PATTERN}" "${abs_path}" 2>/dev/null)
}

while IFS= read -r file; do
	[[ -z "${file}" ]] && continue
	scan_file "${file}" "false"
done < <(git -C "${HOOK_PROJECT_ROOT}" diff HEAD --name-only 2>/dev/null)

while IFS= read -r file; do
	[[ -z "${file}" ]] && continue
	scan_file "${file}" "true"
done < <(git -C "${HOOK_PROJECT_ROOT}" ls-files --others --exclude-standard 2>/dev/null)

if [[ -z "${FINDINGS}" ]]; then
	noop_exit
fi

echo "[DRIFT GUARD] Completion claimed but stub markers remain on added/untracked lines:" >&2
echo "${FINDINGS}" >&2
echo "[DRIFT GUARD] Resolve the stubs before claiming done, or stop claiming completion. Set OMCA_HOOK_DISABLE_DRIFT_GUARD=1 to bypass." >&2
exit 2
