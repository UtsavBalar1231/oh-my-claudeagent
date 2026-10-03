# Proof ledger for the Evidence tab

Show the bound plan's final verdict, every verification run grouped by day, and the output
of the run under the cursor, with secrets masked.

## TODOs

### Milestone 1: model

- [x] 1. Parse the ledger into typed entries
  - File: src/core/evidence.ts
  - Done when: `bun test src/core/evidence.spec.ts` passes
- [x] 2. Read the verdict the Stop gate reads
  - File: src/core/evidence.ts
  - Done when: complete, stale and missing each have a spec

### Milestone 2: view

- [x] 3. Draw the verdict card and the day timeline
  - File: hooks/tabs/evidence.ts
  - Done when: `just test-mod` passes at 80, 120 and 200 columns
- [x] 4. Open the focused entry with its masked output
  - File: hooks/tabs/evidence.ts
  - Done when: a fake token in an output snippet draws masked
- [x] 5. Filter by type, failures and search
  - File: hooks/tabs/evidence.ts
  - Done when: each hotkey has a drawn-tree test

### Milestone 3: proof

- [x] 6. Capture the tab in a real terminal
  - File: tests/mod/visual/evidence.json
  - Done when: `just visual evidence` writes three captures
