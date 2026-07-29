# pattern: *.md

## Prose rules

No em dashes or en dashes in running prose. Use a period, comma, colon, or parentheses.
A dash inside a table cell as a none or not-applicable marker stays.

Delete these; each carries no information:

- Trailing "-ing" justification clause: "..., ensuring maintainability".
- Adjective triples: "clean, maintainable, and scalable". Name the one property.
- Negative parallelism: "not just X, but Y". State Y directly.
- Puffery: comprehensive, robust, seamless, showcasing, exemplifies.
- Copula avoidance: serves as, stands as, represents. Use "is".
- Vague attribution: "best practices suggest". Cite the source or drop the rule.

Sentence case headings. Plain technical voice, no first person, one idea per sentence,
imperative mood and present tense.

Preserve byte-identical: YAML frontmatter, headings other code greps for, code blocks,
tool names, paths, and bracketed tokens.
