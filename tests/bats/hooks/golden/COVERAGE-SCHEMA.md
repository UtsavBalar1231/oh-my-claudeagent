# Pass Coverage Entry Schema

Every script in `scripts/` must have a per-pass entry in
`.omca/notes/refactor-hook-corpus-coverage.md` for each of the 7 pass headings:
Pass 1, Pass 2, Pass 3, Pass 4, Pass 5, Pass 6a, Pass 6b.

## Entry format

```markdown
### <script.sh>
- Pass 1: <edited|reviewed-no-change> — <rationale>
- Pass 2: <edited|reviewed-no-change> — <rationale>
- Pass 3: <edited|reviewed-no-change> — <rationale>
- Pass 4: <edited|reviewed-no-change> — <rationale>
- Pass 5: <edited|reviewed-no-change> — <rationale>
- Pass 6a: <edited|reviewed-no-change> — <rationale>
- Pass 6b: <edited|reviewed-no-change> — <rationale>
```

## Rationale requirements

- **edited**: state which pattern was addressed and the file:line of the change.
- **reviewed-no-change**: MUST include the grep command (or equivalent evidence)
  whose empty result justifies the no-change status.
  Example: `- Pass 1: reviewed-no-change — \`grep -nE '2>/dev/null \|\| echo ""' scripts/permission-filter.sh\` returns empty`

## Completeness check

`grep -c "^- Pass " .omca/notes/refactor-hook-corpus-coverage.md` must return ≥ 245
(35 scripts × 7 pass headings, counting Pass 6a and Pass 6b separately).
