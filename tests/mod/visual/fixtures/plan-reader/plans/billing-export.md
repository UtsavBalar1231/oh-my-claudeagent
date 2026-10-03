# Rebuild the billing export on the shared ledger

**Scope**: 14 files | **Parallel Execution**: YES - 3 waves | **Status**: FINAL

## Why
- The nightly export reads three tables twice and takes 41 minutes on the March data set.
- Finance reconciles by hand because negative totals round the wrong way.

## Work Objectives
### Must have
- One pass over the ledger, totals that match the invoices to the cent.
### Must not have
- No schema change to stored invoices.

## TODOs

### Milestone 0: Foundations

- [x] 1. Define the export schema and its version field
  - File: `src/export/schema.ts`
  - Do: Name every column the finance team reads, with its type and unit.
  - Done when: `bun run build` exits 0.
- [x] 2. Read the ledger in one pass
  - File: `src/ledger/reader.ts`, `src/ledger/reader.spec.ts`
  - Do: Stream the ledger once and hand each row to the writer; no second query.
  - Done when: `bun test src/ledger` exits 0.
  - Depends: 1

### Milestone 1: Exporter

- [x] 3. Write rows in the schema's order
  - File: `src/export/writer.ts`, `src/export/writer.spec.ts`
  - Do: Write each row as the schema orders it and **flush every 1,000 rows**.
  - Done when: `bun test src/export` exits 0.
  - Depends: 1, 2
- [x] 4. Round negative totals toward zero
  - File: `src/export/rounding.ts`
  - Do: Use banker's rounding for positive totals and round negatives toward zero, as finance expects.
  - Done when: `bun test src/export` exits 0 and the March totals match to the cent.
  - Depends: 3
- [ ] 5. Reconcile totals against the invoice table
  - File: `src/report/totals.ts`, `src/report/totals.spec.ts`
  - Do: Sum each customer's rows and compare with the invoice table; list every mismatch.
  - Done when: `DB_PASSWORD=hunter2 just test-db` exits 0.
  - Depends: 4

### Milestone 2: Rollout

- [ ] 6. Run the new export beside the old one for a week
  - File: `src/export/shadow.ts` (new)
  - Do: Write both exports nightly and diff them; page nobody on a diff yet.
  - Done when: `bun test src/export/shadow.spec.ts` exits 0.
  - Depends: 5
- [ ] 7. Document the export columns for finance
  - File: `docs/export.md`
  - Do: One table per file: column, type, unit, source.
  - Done when: `just validate --check claims` exits 0.
  - Depends: 1
- [ ] 8. Switch the nightly job to the new export
  - File: `jobs/nightly.ts`
  - Do: Point the job at the new exporter and keep the old one behind a flag for a release.
  - Done when: `just ci` exits 0.
  - Depends: 6, 7
- [ ] 9. Announce the change to finance
  - Do: Post the column table and the switch date in the finance channel.
  - Done when: finance confirms the March totals.
  - Depends: 8

## Verification
- `just ci` exits 0.
- The nightly export finishes under 10 minutes on the March data set.

## Deferred backlog (not scheduled)

These are plain bullets, not numbered checkboxes, so plan progress never counts them.

### Exporter

- **Parallel writers** (M). Split the ledger by customer and write in parallel.
- **Compressed output** (S). Gzip the export when finance's tool accepts it.

### Reporting

- **Mismatch dashboard** (L). Chart the reconciliation mismatches per day.
