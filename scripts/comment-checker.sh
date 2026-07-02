#!/bin/bash

_HOOK_START=$(date +%s%N 2>/dev/null || date +%s)

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

hook_is_disabled "comment-checker" && exit 0

json_content=$(jq -r '
  def file_payloads:
    [ .tool_response.files?, .tool_response.result.files?, .tool_response.metadata.files? ]
    | map(select(type == "array")[]?)
    | map(
        select((.type? // "") != "delete")
        | (.after? // .new? // .newString? // .new_string? // empty)
        | select(type == "string")
      )
    | .[];

  (
    .tool_input.content?,
    .tool_input.new_string?,
    (.tool_input.edits? | if type == "array" then .[] else empty end | (.new_string? // .newString? // empty)),
    file_payloads
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

WARNINGS=""

if echo "${CONTENT}" | grep -qi "# AI-generated"; then
	WARNINGS+="AI attribution comment detected. "
fi

if echo "${CONTENT}" | grep -qi "# This code was written by"; then
	WARNINGS+="AI authorship comment detected. "
fi

if echo "${CONTENT}" | grep -qi "TODO: implement"; then
	WARNINGS+="Unimplemented TODO placeholder detected. "
fi

CONSECUTIVE=$(echo "${CONTENT}" | awk '
  /^[[:space:]]*#/ || /^[[:space:]]*\/\// { count++; if (count > max) max = count; next }
  { count = 0 }
  END { print max+0 }
')
if [[ "${CONSECUTIVE}" -gt 5 ]]; then
	WARNINGS+="Excessive consecutive comment lines (${CONSECUTIVE} in a row) detected. "
fi

# Slop-pattern findings (categories 4-8). Emitted as "category|detail" lines
# by a single awk pass so every check shares one line array and one @allow
# bypass check.
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
    split("this that these those with from into your the and for are was were will can may " \
          "should would could function method returns return value values", sw, " ")
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

      # 1. Code-restating comment: shares >=2 meaningful tokens with the next
      # non-blank code line, and contributes no token absent from that line.
      if (findings < cap) {
        j = i + 1
        while (j <= n && lines[j] ~ /^[[:space:]]*$/) j++
        if (j <= n && !is_comment(lines[j])) {
          delete ctoks; delete codetoks
          tokenize(lc, ctoks)
          tokenize(tolower(lines[j]), codetoks)
          shared = 0; extra = 0
          for (t in ctoks) {
            if (t in codetoks) shared++
            else extra++
          }
          if (shared >= 2 && extra == 0) {
            print "restates|" text
            findings++
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
            if (shared2 >= 1 && extra2 == 0) {
              print "trivial-doc|" text
              findings++
            }
          }
        }
      }
    }
  }
')

if [[ -n "${SLOP_FINDINGS}" ]]; then
	while IFS='|' read -r category detail; do
		[[ -z "${category}" ]] && continue
		case "${category}" in
			separator) WARNINGS+="Decorative separator comment detected (\"${detail}\"). " ;;
			filler) WARNINGS+="Filler-word comment detected (\"${detail}\"). " ;;
			bare-todo) WARNINGS+="Context-free TODO/FIXME detected (\"${detail}\"): add an issue ref, owner, or explanation. " ;;
			restates) WARNINGS+="Comment restates the following code line (\"${detail}\"). " ;;
			trivial-doc) WARNINGS+="Doc comment adds nothing beyond the function name (\"${detail}\"). " ;;
			*) ;;
		esac
	done <<< "${SLOP_FINDINGS}"
fi

hook_timing_log "${_HOOK_START}"

if [[ -n "${WARNINGS}" ]]; then
	MSG="[COMMENT CHECK] Detected potential AI slop patterns. Review the written content for unnecessary comments or placeholder code. Details: ${WARNINGS}"
	emit_context "PostToolUse" "${MSG}"
else
	exit 0
fi
