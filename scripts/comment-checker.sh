#!/bin/bash
# Flags AI-slop comment patterns in written content, and (when gating is on)
# denies the write before it lands. Fires on PreToolUse Write|Edit|MultiEdit.
#
# OMCA_COMMENT_GATE=off|advise|deny controls enforcement; default "advise"
# computes deny decisions and logs them without blocking (shadow mode).

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

_HOOK_START=$(epoch_ns)

hook_is_disabled "comment-checker" && exit 0

GATE_MODE="${OMCA_COMMENT_GATE:-advise}"
if [[ "${GATE_MODE}" == "off" ]]; then
	exit 0
fi

FILE_PATH=$(jq -r '.tool_input.file_path // ""' <<< "${HOOK_INPUT}" 2>/dev/null)

# Comment syntax is language-specific, but the line matchers here (`#`, `//`)
# also match Markdown headings and are meaningless in prose. Restricting to
# source extensions is what keeps this repo's Markdown-first content out of
# scope. A payload with no file_path stays in scope: real Write/Edit calls
# always carry one, so absence means a synthetic or test payload.
if [[ -n "${FILE_PATH}" ]]; then
	case "${FILE_PATH}" in
	*.sh | *.bash | *.zsh | *.py | *.js | *.jsx | *.ts | *.tsx | *.go | *.rs) ;;
	*.c | *.h | *.cpp | *.hpp | *.java | *.rb | *.php | *.lua | *.swift | *.kt) ;;
	*) exit 0 ;;
	esac
fi

# The checker's own detection strings and the bats fixtures that exercise them
# contain these literals verbatim. Without this exemption the gate blocks edits
# to its own source with no bypass the model can reach.
case "${FILE_PATH}" in
*/scripts/comment-checker.sh | */tests/*) exit 0 ;;
*) ;;
esac

json_content=$(jq -r '
  (
    .tool_input.content?,
    .tool_input.new_string?,
    (.tool_input.edits? | if type == "array" then .[] else empty end | (.new_string? // .newString? // empty))
  )
  | select(type == "string")
' <<< "${HOOK_INPUT}" 2>/dev/null || true)

patch_content=$(jq -r '
  (
    .tool_input.patchText?,
    .tool_input.input?,
    .tool_input.patch?,
    .tool_input.command?
  )
  | select(type == "string")
' <<< "${HOOK_INPUT}" 2>/dev/null \
	| awk '
      /^\+\+\+/ { next }
      /^\+/ { sub(/^\+/, ""); print }
    ' || true)

CONTENT=$(printf '%s\n%s' "${json_content}" "${patch_content}")

if [[ -z "${CONTENT}" ]]; then
	exit 0
fi

# Whole-file opt-out: a marker anywhere in the first 5 lines of the changed
# content exempts this hunk entirely (mirrors editor "no-lint" line markers).
if printf '%s\n' "${CONTENT}" | head -n 5 | grep -q "comment-checker-disable-file"; then
	exit 0
fi

# Tier 1 — literal attribution/placeholder strings. Near-zero false positive,
# so these are the only findings safe to hard-deny unconditionally.
TIER1=""

if echo "${CONTENT}" | grep -qi "# AI-generated"; then
	TIER1+="AI attribution comment detected. "
fi

if echo "${CONTENT}" | grep -qi "# This code was written by"; then
	TIER1+="AI authorship comment detected. "
fi

# "TODO: implement" carrying an owner or issue ref is a tracked task, not a
# placeholder, so it is exempt here exactly as it is in the bare-todo check.
if echo "${CONTENT}" | awk '
  BEGIN { hit = 0 }
  tolower($0) ~ /todo:[[:space:]]*implement/ {
    if ($0 !~ /#[0-9]+/ && $0 !~ /[A-Z]+-[0-9]+/ && $0 !~ /@[A-Za-z]/) hit = 1
  }
  END { exit (hit ? 0 : 1) }
'; then
	TIER1+="Unimplemented TODO placeholder detected. "
fi

# Tier 3 — whole-hunk aggregates. No per-line finding to quote and mandated
# Google-style headers can legitimately reach these ratios, so these stay
# advisory permanently and never contribute to a deny.
TIER3=""

CONSECUTIVE=$(echo "${CONTENT}" | awk '
  /^[[:space:]]*#/ || /^[[:space:]]*\/\// { count++; if (count > max) max = count; next }
  { count = 0 }
  END { print max+0 }
')
if [[ "${CONSECUTIVE}" -gt 5 ]]; then
	TIER3+="Excessive consecutive comment lines (${CONSECUTIVE} in a row) detected. "
fi

read -r COMMENT_LINES CODE_LINES <<< "$(printf '%s\n' "${CONTENT}" | awk '
  /^[[:space:]]*$/ { next }
  /^[[:space:]]*#/ || /^[[:space:]]*\/\// { c++; next }
  { k++ }
  END { print c+0, k+0 }
')"
# Line-by-line narration interleaves one comment per code line, so it never
# trips the consecutive-run check above; density is what catches it. 40% of
# non-blank lines, floor of 6, keeps file headers and magic-number
# derivations in a normal hunk well clear.
if [[ "${COMMENT_LINES}" -ge 6 ]] \
	&& [[ $((COMMENT_LINES * 10)) -ge $(((COMMENT_LINES + CODE_LINES) * 4)) ]]; then
	TIER3+="High comment density (${COMMENT_LINES} comment lines to ${CODE_LINES} code lines): likely line-by-line narration rather than documentation. "
fi

# Tier 2 — per-line heuristic findings (categories 1-5). Emitted as
# "category|detail" lines by a single awk pass so every check shares one line
# array and one @allow bypass check.
SLOP_FINDINGS=$(printf '%s\n' "${CONTENT}" | awk '
  function is_comment(l) {
    return (l ~ /^[[:space:]]*#/ || l ~ /^[[:space:]]*\/\//)
  }
  function strip_marker(l,    s) {
    s = l
    sub(/^[[:space:]]*(#|\/\/)[[:space:]]*/, "", s)
    return s
  }
  # Split text on non-alphanumeric boundaries into a lowercase token set,
  # dropping stopwords and short tokens that are too generic to signal reuse.
  function tokenize(text, toks,    n, i, w) {
    n = split(tolower(text), w, /[^a-z0-9]+/)
    for (i = 1; i <= n; i++) {
      if (length(w[i]) >= 4 && !(w[i] in STOPWORDS)) toks[w[i]] = 1
    }
  }
  # Split an identifier on snake_case/camelCase boundaries into lowercase words.
  function name_tokens(name, out,    tmp, n, i) {
    tmp = name
    gsub(/([a-z0-9])([A-Z])/, "\\1_\\2", tmp)
    n = split(tolower(tmp), parts, /[^a-z0-9]+/)
    for (i = 1; i <= n; i++) if (length(parts[i]) > 0) out[parts[i]] = 1
  }
  BEGIN {
    cap = 5  # advisory cap: additionalContext should stay skimmable, not a wall of text
    # "return"/"value"/"values" are deliberately NOT stopwords: dropping them
    # made bodies like "return the values" tokenize to empty, so the restates
    # check could never fire on the most common narration shape.
    split("this that these those with from into your the and for are was were will can may " \
          "should would could function method", sw, " ")
    for (i in sw) STOPWORDS[sw[i]] = 1
  }
  { lines[NR] = $0 }
  END {
    n = NR
    for (i = 1; i <= n; i++) {
      l = lines[i]
      if (!is_comment(l)) continue
      if (l ~ /@allow/) continue
      if (findings >= cap) break
      text = strip_marker(l)
      lc = tolower(text)

      # 3. Decorative separator: comment body is only repeated punctuation, 3+.
      bare = text
      gsub(/[[:space:]]/, "", bare)
      if (bare ~ /^(=|-|\*|_|~|\^){3,}$/) {
        print "separator|" text
        findings++
        continue
      }

      # 2. Filler-word qualifier, standalone (word-boundary match).
      if (lc ~ /(^|[^a-z])(obviously|clearly|simply|just|basically)([^a-z]|$)/) {
        print "filler|" text
        findings++
      }

      # 5. Context-free TODO/FIXME: no issue ref, no owner mention, no clause.
      if (lc ~ /(todo|fixme)/) {
        has_ref = (text ~ /#[0-9]+/) || (text ~ /[A-Z]+-[0-9]+/) || (text ~ /@[A-Za-z]/)
        rest = text
        sub(/.*[Tt][Oo][Dd][Oo]/, "", rest)
        sub(/.*[Ff][Ii][Xx][Mm][Ee]/, "", rest)
        gsub(/^[:,\-]+[[:space:]]*/, "", rest)
        gsub(/^[[:space:]]+/, "", rest)
        nwords = split(rest, rw, /[[:space:]]+/)
        if (!has_ref && nwords < 3 && findings < cap) {
          print "bare-todo|" text
          findings++
        }
      }

      # 1. Code-restating comment: shares meaningful tokens with the next
      # non-blank code line and contributes at most one token of its own.
      if (findings < cap) {
        j = i + 1
        while (j <= n && lines[j] ~ /^[[:space:]]*$/) j++
        if (j <= n && !is_comment(lines[j])) {
          # Magic-number derivation carve-out: the shell-script policy here
          # REQUIRES a comment above every numeric constant, and the terse
          # mandated form ("# 300s evidence age" over "MAX_AGE=300") restates
          # by construction. Exempt the shape rather than block the rule.
          is_magic_number = (text ~ /[0-9]/ && lines[j] ~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*-?[0-9]/)
          if (!is_magic_number) {
            delete ctoks; delete codetoks
            tokenize(lc, ctoks)
            tokenize(tolower(lines[j]), codetoks)
            shared = 0; extra = 0
            for (t in ctoks) {
              if (t in codetoks) shared++
              else extra++
            }
            # extra <= 1 rather than == 0: a restating comment nearly always
            # carries one word of its own ("# set the path attribute" over
            # "self.path = path"), which the == 0 form could never match.
            if (shared >= 1 && extra <= 1) {
              print "restates|" text
              findings++
            }
          }
        }
      }

      # 4. Doc-comment directly above a trivially-named one-line function body.
      if (findings < cap) {
        j = i + 1
        if (j <= n && lines[j] ~ /^[[:space:]]*(def|function|fn|func)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\(/) {
          defline = lines[j]
          match(defline, /^[[:space:]]*/)
          def_indent = RLENGTH
          fname = defline
          sub(/^[[:space:]]*(def|function|fn|func)[[:space:]]+/, "", fname)
          sub(/[[:space:]]*\(.*/, "", fname)
          is_oneliner = 0
          if (defline ~ /:[[:space:]]*$/) {
            # python-style: exactly one indented body line, then dedent/EOF
            k = j + 1
            while (k <= n && lines[k] ~ /^[[:space:]]*$/) k++
            if (k <= n) {
              body = lines[k]
              match(body, /^[[:space:]]*/)
              body_indent = RLENGTH
              if (body_indent > def_indent) {
                m = k + 1
                while (m <= n && lines[m] ~ /^[[:space:]]*$/) m++
                if (m > n) {
                  is_oneliner = 1
                } else {
                  match(lines[m], /^[[:space:]]*/)
                  if (RLENGTH <= def_indent) is_oneliner = 1
                }
              }
            }
          } else if (defline ~ /\{[[:space:]]*$/) {
            # brace-style: body line then a lone closing brace
            k = j + 1
            while (k <= n && lines[k] ~ /^[[:space:]]*$/) k++
            if (k <= n && lines[k] !~ /^[[:space:]]*\}/) {
              m = k + 1
              while (m <= n && lines[m] ~ /^[[:space:]]*$/) m++
              if (m <= n && lines[m] ~ /^[[:space:]]*\}[[:space:]]*$/) is_oneliner = 1
            }
          }
          if (is_oneliner) {
            delete nametoks; delete ctoks2
            name_tokens(fname, nametoks)
            tokenize(lc, ctoks2)
            shared2 = 0; extra2 = 0
            for (t in ctoks2) {
              if (t in nametoks) shared2++
              else extra2++
            }
            if (shared2 >= 1 && extra2 <= 1) {
              print "trivial-doc|" text
              findings++
            }
          }
        }
      }
    }
  }
')

TIER2=""
QUOTED=""
if [[ -n "${SLOP_FINDINGS}" ]]; then
	while IFS='|' read -r category detail; do
		[[ -z "${category}" ]] && continue
		case "${category}" in
		separator) TIER2+="Decorative separator comment (\"${detail}\"): delete it. " ;;
		filler) TIER2+="Filler-word comment (\"${detail}\"): delete it. " ;;
		bare-todo) TIER2+="Context-free TODO/FIXME (\"${detail}\"): add an issue ref or TODO(owner):. " ;;
		restates) TIER2+="Comment restates the following code line (\"${detail}\"): delete it, or replace it with the non-obvious why. " ;;
		trivial-doc) TIER2+="Doc comment adds nothing beyond the function name (\"${detail}\"): delete it. " ;;
		*) ;;
		esac
		QUOTED+="${detail}"
	done <<< "${SLOP_FINDINGS}"
fi

hook_timing_log "${_HOOK_START}"

if [[ -z "${TIER1}${TIER2}${TIER3}" ]]; then
	exit 0
fi

# Every deny names the categories that must survive the fix. Without it the
# model "resolves" a deny by stripping required comments, which is the
# strip-everything overcorrection the project's comment policy forbids.
PROTECTED="The convention: names, types, and structure carry the what, so a comment earns its place only by carrying something the code cannot state, the non-obvious why, an invariant, a constraint, or the derivation of a magic number. A correct fix deletes the quoted comment, or rewrites it as the reason the code is the way it is. A clearer name beats a comment that restates the line below it. Do NOT remove other comments while fixing this: file headers, non-obvious function contracts, invariant notes, and magic-number derivation comments are REQUIRED and must survive. Resubmit the same code change with only the quoted comments fixed. Genuine exceptions: put comment-checker-disable-file in the first 5 lines of the hunk."

# Usage: deny <reason text> <tier label>
deny() {
	# Log before emitting: without this the audit trail holds shadow-mode
	# would-denies and nothing at all once the gate is enforcing. The tier label
	# rather than the reason keeps the entry short enough to scan; the quoted
	# finding text lives in the deny message the model receives.
	log_hook_info "denied ($2) ${FILE_PATH}" "$(basename "$0")"
	jq -nc --arg reason "$1" \
		'{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
	exit 0
}

advise() {
	emit_context "PreToolUse" "[COMMENT CHECK] $1"
}

ADVISORY="Detected AI slop comment patterns. Remove the quoted comments with a follow-up Edit unless they encode a non-obvious why. ${TIER1}${TIER2}${TIER3}"

if [[ "${GATE_MODE}" != "deny" ]]; then
	# Shadow mode: record what a live gate would have blocked, then advise only.
	if [[ -n "${TIER1}" ]]; then
		log_hook_info "would-deny (tier1) ${FILE_PATH}: ${TIER1}" "$(basename "$0")"
	elif [[ -n "${TIER2}" ]]; then
		log_hook_info "would-deny (tier2) ${FILE_PATH}: ${TIER2}" "$(basename "$0")"
	fi
	advise "${ADVISORY}"
	exit 0
fi

if [[ -n "${TIER1}" ]]; then
	deny "Blocked: AI-attribution or placeholder comment. ${TIER1}${PROTECTED}" "tier1"
fi

if [[ -z "${TIER2}" ]]; then
	advise "${ADVISORY}"
	exit 0
fi

# Deny-once loop breaker: heuristics are lexical and cannot always tell slop
# from a genuine non-obvious comment, so a repeat attempt on the same file and
# findings fails open rather than trapping the edit in a retry loop.
GATE_STATE="${HOOK_STATE_DIR}/comment-gate-window.json"
SIG=$(printf '%s\n%s' "${FILE_PATH}" "${QUOTED}" | sha256_of_stdin)
PREV_SIG=$(jq_read "${GATE_STATE}" '.signature' "")

if [[ "${SIG}" == "${SHA256_UNAVAILABLE}" ]]; then
	log_hook_info "no digest tool; tier2 gate advises instead of denying: ${FILE_PATH}" "$(basename "$0")"
	advise "${ADVISORY}"
	exit 0
fi
SIG="${SIG:0:16}"

if [[ "${SIG}" == "${PREV_SIG}" ]]; then
	log_hook_info "gate failed open after repeat deny: ${FILE_PATH}" "$(basename "$0")"
	tmp=$(mktemp) && jq -nc '{}' > "${tmp}" && mv "${tmp}" "${GATE_STATE}"
	advise "${ADVISORY}"
	exit 0
fi

tmp=$(mktemp) \
	&& jq -nc --arg sig "${SIG}" --arg f "${FILE_PATH}" '{signature: $sig, file_path: $f}' > "${tmp}" \
	&& mv "${tmp}" "${GATE_STATE}"

deny "Blocked: comment slop. ${TIER2}${PROTECTED}" "tier2"
