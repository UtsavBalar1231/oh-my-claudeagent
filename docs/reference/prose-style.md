# Prose style for authored Markdown

Canonical style reference for authored Markdown in this repo: agent bodies, skill bodies,
plan files, `docs/`, and `README.md`. Code comments are out of scope and live in
`docs/reference/code-comments.md`.

Three consumers point here rather than restating the rules: `agents/prometheus.md` writes
plan prose against it, `agents/executor.md` applies it on Markdown-only tasks, and
`agents/momus.md` checks it as an advisory review criterion. Reference this file; do not
copy it.

## Scope

`scripts/comment-checker.sh` exits early on non-source extensions, so Markdown never reaches
the mechanical comment gate. No hook, linter, or test enforces prose style. This document is
the only policy covering it, and it is enforced by review.

## Voice

These are functional reference documents. The target is a sharp human engineer writing terse
docs, not a chatty assistant and not a marketing page.

- Plain and technical. No personality, no jokes, no encouragement.
- No first person. Write about the system, not about the writer.
- One idea per sentence. Prefer a short sentence over a qualified one.
- State the rule, then the reason. Skip the windup.

## Structure rules

Sourced from the Google developer documentation style guide and the Linux kernel
documentation process guide.

- **Imperative mood, present tense** for instructions and task descriptions. Write "make the
  parser reject empty input", not "this change makes the parser reject empty input". Linux
  `Documentation/process/submitting-patches.rst`: "Describe your changes in imperative mood
  [...] as if you are giving orders to the codebase to change its behaviour."
  (https://www.kernel.org/doc/html/latest/process/submitting-patches.html)
- **Present tense for general behavior.** "The hook writes the state file", not "the hook
  will write the state file". (https://developers.google.com/style/tense)
- **Procedural steps start with an imperative verb**, one action per step, and state the
  location before the action: "In `hooks/hooks.json`, add the handler."
  (https://developers.google.com/style/procedures)
- **Sentence case for headings.** "Structure rules", not "Structure Rules".
  (https://developers.google.com/style/headings)
- **Split any task description longer than two lines.** If it does not fit in two lines, it
  is two tasks or it is padded.

## Banned phrasing

Grounded in Wikipedia's "Signs of AI writing"
(https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing). Each pattern below is a
reliable tell that carries no information. Delete it or replace it with a fact.

| Pattern | Example to delete | Fix |
|---|---|---|
| Trailing "-ing" justification clause | "..., ensuring maintainability", "..., highlighting the importance of", "..., enabling future extensibility" | Cut the clause. If the benefit is real, state it as its own sentence with a mechanism. |
| Rule of three, adjective triples | "clean, maintainable, and scalable" | Name the one property that matters. |
| Negative parallelism | "not just X, but Y", "this isn't a refactor, it's a rethink" | State Y directly. |
| Puffery | "comprehensive", "robust", "seamless", "showcasing", "exemplifies", "commitment to" | Delete. Replace with a measurable claim or nothing. |
| Copula avoidance | "serves as", "stands as", "represents", "marks" | Use "is". |
| Inflated verbs for possession | "features", "offers", "boasts" | Use "has". |
| Vague attribution | "best practices suggest", "industry standards recommend", "it is widely considered" | Cite the source, or drop the rule. An unsourced style opinion is this same pattern. |
| Em dash or en dash in prose | any | Use a period, comma, colon, or parentheses. Hard rule. |
| Emoji as structure | section markers, status glyphs | Use headings, lists, or plain words. |
| Excessive boldface | bolding whole sentences or every list lead | Bold the term being defined, nothing else. |
| Title Case headings | "How To Configure The Hook" | Sentence case. |

Two consequences worth stating outright. First, a benefit clause with no mechanism is
noise: "improves performance" without a number says nothing. Second, a rule you cannot
source does not belong in a style document.

### Dash exception

A dash used inside a table cell as a none, empty, or not-applicable marker is a normal human
convention and stays. A de-slopping pass must not strip those. The ban covers dashes in
running prose only.

## Preserve byte-identical

A prose pass must not touch the following. Each is load-bearing at runtime or in CI.

- **YAML frontmatter** in `agents/*.md` and `skills/*/SKILL.md`. A skill `description:` is
  trigger-matched by the platform and character-capped (1,536 hard, 512 soft in this repo),
  so rewording it changes which prompts invoke the skill and can fail
  `scripts/validate-plugin.sh`.
- **Headings that other code greps for.** `tests/bats/unit/prometheus_template.bats` asserts
  on the literal `### Completion Signaling` in `agents/prometheus.md`. Grep before renaming
  any heading.
- **Code blocks and output-format template blocks.** The text inside a fenced block is data,
  not prose.
- **Tool names, file paths, and bracketed tokens** such as `[VERIFICATION]` or
  `${CLAUDE_PLUGIN_ROOT}`.

When a preserved string itself violates a rule above, leave it and note the conflict rather
than editing it.

## Applying this document

Reread a finished document against the banned-phrasing table before submitting it. The
table is short enough to scan, and the patterns cluster: a document with one trailing "-ing"
clause usually has four.
