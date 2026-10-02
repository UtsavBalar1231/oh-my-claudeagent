# Ship the sample widget service rewrite

**Scope**: about 120 files | **Parallel Execution**: YES - 6 waves | **Status**: FINAL

## Why
- The current service mixes three runtimes and each request crosses four process boundaries.
- Measured p50 latency is 41 ms, of which 30 ms is process start.

## Work Objectives
### Must have
- One runtime, one process, and every endpoint covered by a contract test.
### Must not have
- No new runtime dependency and no schema change to stored records.

## Design decisions
| Decision | Choice | Reason |
|---|---|---|
| Transport | stdio | no port to manage |
| Storage | JSON files | readable by the old service during the upgrade |

## TODOs

### Milestone 0: Foundations

- [x] 1. Port the window and the recorder onto the shared parser
  - File: `src/window.ts`, `src/recorder.spec.ts`
  - Do: Move the window logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/recorder.spec.ts` exits 0 and the old adapter is gone.
  - Depends: none
- [x] 2. Port the ledger and the router onto the shared harness
  - File: `src/ledger.ts`, `src/router.spec.ts`
  - Do: Move the ledger logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/router.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 1
- [x] 3. Port the fixture and the tracker onto the shared snapshot
  - File: `src/fixture.ts`, `src/tracker.spec.ts`
  - Do: Move the fixture logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/tracker.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 2
- [x] 4. Port the theme and the band onto the shared gate
  - File: `src/theme.ts`, `src/band.spec.ts`
  - Do: Move the theme logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/band.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 3
- [x] 5. Port the probe and the reader onto the shared guard
  - File: `src/probe.ts`, `src/reader.spec.ts`
  - Do: Move the probe logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/reader.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 4
- [x] 6. Port the recorder and the parser onto the shared pane
  - File: `src/recorder.ts`, `src/parser.spec.ts`
  - Do: Move the recorder logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/parser.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 5
- [x] 7. Rename every `widget_id` column reference in the export path, the import path, the nightly reconciliation job and the three admin reports so that the long title has to be truncated
  - File: `src/router.ts`, `src/harness.spec.ts`
  - Do: Move the router logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/harness.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 6
- [x] 8. Port the tracker and the snapshot onto the shared ledger
  - File: `src/tracker.ts`, `src/snapshot.spec.ts`
  - Do: Move the tracker logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/snapshot.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 7
### Milestone 1: Core features

- [x] 9. Port the band and the gate onto the shared fixture
  - File: `src/band.ts`, `src/gate.spec.ts`
  - Do: Move the band logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/gate.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 8
- [x] 10. Port the reader and the guard onto the shared theme
  - File: `src/reader.ts`, `src/guard.spec.ts`
  - Do: Move the reader logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/guard.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 9
- [x] 11. Port the parser and the pane onto the shared probe
  - File: `src/parser.ts`, `src/pane.spec.ts`
  - Do: Move the parser logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/pane.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 10
- [x] 12. Port the harness and the window onto the shared recorder
  - File: `src/harness.ts`, `src/window.spec.ts`
  - Do: Move the harness logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/window.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 11
- [ ] 13. Port the snapshot and the ledger onto the shared router
  - File: `src/snapshot.ts`, `src/ledger.spec.ts`
  - Do: Move the snapshot logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/ledger.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 12
- [ ] 14. Port the gate and the fixture onto the shared tracker
  - File: `src/gate.ts`, `src/fixture.spec.ts`
  - Do: Move the gate logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/fixture.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 13
- [ ] 15. Port the guard and the theme onto the shared band
  - File: `src/guard.ts`, `src/theme.spec.ts`
  - Do: Move the guard logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/theme.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 14
- [ ] 16. Port the pane and the probe onto the shared reader
  - File: `src/pane.ts`, `src/probe.spec.ts`
  - Do: Move the pane logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/probe.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 15
- [ ] 17. Port the window and the recorder onto the shared parser
  - File: `src/window.ts`, `src/recorder.spec.ts`
  - Do: Move the window logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/recorder.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 16
- [ ] 18. Port the ledger and the router onto the shared harness
  - File: `src/ledger.ts`, `src/router.spec.ts`
  - Do: Move the ledger logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/router.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 17
### Milestone 2: Views and feedback

- [ ] 19. Port the fixture and the tracker onto the shared snapshot
  - File: `src/fixture.ts`, `src/tracker.spec.ts`
  - Do: Move the fixture logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/tracker.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 18
- [ ] 20. Port the theme and the band onto the shared gate
  - File: `src/theme.ts`, `src/band.spec.ts`
  - Do: Move the theme logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/band.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 19
- [ ] 21. Port the probe and the reader onto the shared guard
  - File: `src/probe.ts`, `src/reader.spec.ts`
  - Do: Move the probe logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/reader.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 20
- [ ] 22. Port the recorder and the parser onto the shared pane
  - File: `src/recorder.ts`, `src/parser.spec.ts`
  - Do: Move the recorder logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/parser.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 21
- [ ] 23. Render the 日本語 and 한국어 labels in the router view at full width
  - File: `src/router.ts`, `src/harness.spec.ts`
  - Do: Move the router logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/harness.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 22
- [ ] 24. Port the tracker and the snapshot onto the shared ledger
  - File: `src/tracker.ts`, `src/snapshot.spec.ts`
  - Do: Move the tracker logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/snapshot.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 23
- [ ] 25. Port the band and the gate onto the shared fixture
  - File: `src/band.ts`, `src/gate.spec.ts`
  - Do: Move the band logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/gate.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 24
- [ ] 26. Port the reader and the guard onto the shared theme
  - File: `src/reader.ts`, `src/guard.spec.ts`
  - Do: Move the reader logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/guard.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 25
- [ ] 27. Port the parser and the pane onto the shared probe
  - File: `src/parser.ts`, `src/pane.spec.ts`
  - Do: Move the parser logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/pane.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 26
- [ ] 28. Port the harness and the window onto the shared recorder
  - File: `src/harness.ts`, `src/window.spec.ts`
  - Do: Move the harness logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/window.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 27
### Milestone 3: Ports

- [ ] 29. Port the snapshot and the ledger onto the shared router
  - File: `src/snapshot.ts`, `src/ledger.spec.ts`
  - Do: Move the snapshot logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/ledger.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 28
- [ ] 30. Port the gate and the fixture onto the shared tracker
  - File: `src/gate.ts`, `src/fixture.spec.ts`
  - Do: Move the gate logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/fixture.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 29
- [ ] 31. Port the guard and the theme onto the shared band
  - File: `src/guard.ts`, `src/theme.spec.ts`
  - Do: Step 1: rewrite the pane call site in `src/legacy/probe-0.ts` to use the new reader entry point, run its spec, and record the result before moving on to the next file in the list. Step 2: rewrite the window call site in `src/legacy/recorder-1.ts` to use the new parser entry point, run its spec, and record the result before moving on to the next file in the list. Step 3: rewrite the ledger call site in `src/legacy/router-2.ts` to use the new harness entry point, run its spec, and record the result before moving on to the next file in the list. Step 4: rewrite the fixture call site in `src/legacy/tracker-3.ts` to use the new snapshot entry point, run its spec, and record the result before moving on to the next file in the list. Step 5: rewrite the theme call site in `src/legacy/band-4.ts` to use the new gate entry point, run its spec, and record the result before moving on to the next file in the list. Step 6: rewrite the probe call site in `src/legacy/reader-5.ts` to use the new guard entry point, run its spec, and record the result before moving on to the next file in the list. Step 7: rewrite the recorder call site in `src/legacy/parser-6.ts` to use the new pane entry point, run its spec, and record the result before moving on to the next file in the list. Step 8: rewrite the router call site in `src/legacy/harness-7.ts` to use the new window entry point, run its spec, and record the result before moving on to the next file in the list. Step 9: rewrite the tracker call site in `src/legacy/snapshot-8.ts` to use the new ledger entry point, run its spec, and record the result before moving on to the next file in the list. Step 10: rewrite the band call site in `src/legacy/gate-9.ts` to use the new fixture entry point, run its spec, and record the result before moving on to the next file in the list. Step 11: rewrite the reader call site in `src/legacy/guard-10.ts` to use the new theme entry point, run its spec, and record the result before moving on to the next file in the list. Step 12: rewrite the parser call site in `src/legacy/pane-11.ts` to use the new probe entry point, run its spec, and record the result before moving on to the next file in the list. Step 13: rewrite the harness call site in `src/legacy/window-12.ts` to use the new recorder entry point, run its spec, and record the result before moving on to the next file in the list. Step 14: rewrite the snapshot call site in `src/legacy/ledger-13.ts` to use the new router entry point, run its spec, and record the result before moving on to the next file in the list. Step 15: rewrite the gate call site in `src/legacy/fixture-14.ts` to use the new tracker entry point, run its spec, and record the result before moving on to the next file in the list. Step 16: rewrite the guard call site in `src/legacy/theme-15.ts` to use the new band entry point, run its spec, and record the result before moving on to the next file in the list. Step 17: rewrite the pane call site in `src/legacy/probe-16.ts` to use the new reader entry point, run its spec, and record the result before moving on to the next file in the list. Step 18: rewrite the window call site in `src/legacy/recorder-17.ts` to use the new parser entry point, run its spec, and record the result before moving on to the next file in the list. Step 19: rewrite the ledger call site in `src/legacy/router-18.ts` to use the new harness entry point, run its spec, and record the result before moving on to the next file in the list. Step 20: rewrite the fixture call site in `src/legacy/tracker-19.ts` to use the new snapshot entry point, run its spec, and record the result before moving on to the next file in the list. Step 21: rewrite the theme call site in `src/legacy/band-20.ts` to use the new gate entry point, run its spec, and record the result before moving on to the next file in the list. Step 22: rewrite the probe call site in `src/legacy/reader-21.ts` to use the new guard entry point, run its spec, and record the result before moving on to the next file in the list. Step 23: rewrite the recorder call site in `src/legacy/parser-22.ts` to use the new pane entry point, run its spec, and record the result before moving on to the next file in the list. Step 24: rewrite the router call site in `src/legacy/harness-23.ts` to use the new window entry point, run its spec, and record the result before moving on to the next file in the list. Step 25: rewrite the tracker call site in `src/legacy/snapshot-24.ts` to use the new ledger entry point, run its spec, and record the result before moving on to the next file in the list. Step 26: rewrite the band call site in `src/legacy/gate-25.ts` to use the new fixture entry point, run its spec, and record the result before moving on to the next file in the list. Step 27: rewrite the reader call site in `src/legacy/guard-26.ts` to use the new theme entry point, run its spec, and record the result before moving on to the next file in the list. Step 28: rewrite the parser call site in `src/legacy/pane-27.ts` to use the new probe entry point, run its spec, and record the result before moving on to the next file in the list. Step 29: rewrite the harness call site in `src/legacy/window-28.ts` to use the new recorder entry point, run its spec, and record the result before moving on to the next file in the list. Step 30: rewrite the snapshot call site in `src/legacy/ledger-29.ts` to use the new router entry point, run its spec, and record the result before moving on to the next file in the list. Step 31: rewrite the gate call site in `src/legacy/fixture-30.ts` to use the new tracker entry point, run its spec, and record the result before moving on to the next file in the list. Step 32: rewrite the guard call site in `src/legacy/theme-31.ts` to use the new band entry point, run its spec, and record the result before moving on to the next file in the list. Step 33: rewrite the pane call site in `src/legacy/probe-32.ts` to use the new reader entry point, run its spec, and record the result before moving on to the next file in the list. Step 34: rewrite the window call site in `src/legacy/recorder-33.ts` to use the new parser entry point, run its spec, and record the result before moving on to the next file in the list. Step 35: rewrite the ledger call site in `src/legacy/router-34.ts` to use the new harness entry point, run its spec, and record the result before moving on to the next file in the list. Step 36: rewrite the fixture call site in `src/legacy/tracker-35.ts` to use the new snapshot entry point, run its spec, and record the result before moving on to the next file in the list. Step 37: rewrite the theme call site in `src/legacy/band-36.ts` to use the new gate entry point, run its spec, and record the result before moving on to the next file in the list. Step 38: rewrite the probe call site in `src/legacy/reader-37.ts` to use the new guard entry point, run its spec, and record the result before moving on to the next file in the list. Step 39: rewrite the recorder call site in `src/legacy/parser-38.ts` to use the new pane entry point, run its spec, and record the result before moving on to the next file in the list. Step 40: rewrite the router call site in `src/legacy/harness-39.ts` to use the new window entry point, run its spec, and record the result before moving on to the next file in the list. Step 41: rewrite the tracker call site in `src/legacy/snapshot-40.ts` to use the new ledger entry point, run its spec, and record the result before moving on to the next file in the list. Step 42: rewrite the band call site in `src/legacy/gate-41.ts` to use the new fixture entry point, run its spec, and record the result before moving on to the next file in the list. Step 43: rewrite the reader call site in `src/legacy/guard-42.ts` to use the new theme entry point, run its spec, and record the result before moving on to the next file in the list. Step 44: rewrite the parser call site in `src/legacy/pane-43.ts` to use the new probe entry point, run its spec, and record the result before moving on to the next file in the list. Step 45: rewrite the harness call site in `src/legacy/window-44.ts` to use the new recorder entry point, run its spec, and record the result before moving on to the next file in the list. Step 46: rewrite the snapshot call site in `src/legacy/ledger-45.ts` to use the new router entry point, run its spec, and record the result before moving on to the next file in the list. Step 47: rewrite the gate call site in `src/legacy/fixture-46.ts` to use the new tracker entry point, run its spec, and record the result before moving on to the next file in the list. Step 48: rewrite the guard call site in `src/legacy/theme-47.ts` to use the new band entry point, run its spec, and record the result before moving on to the next file in the list. Step 49: rewrite the pane call site in `src/legacy/probe-48.ts` to use the new reader entry point, run its spec, and record the result before moving on to the next file in the list. Step 50: rewrite the window call site in `src/legacy/recorder-49.ts` to use the new parser entry point, run its spec, and record the result before moving on to the next file in the list. Step 51: rewrite the ledger call site in `src/legacy/router-50.ts` to use the new harness entry point, run its spec, and record the result before moving on to the next file in the list. Step 52: rewrite the fixture call site in `src/legacy/tracker-51.ts` to use the new snapshot entry point, run its spec, and record the result before moving on to the next file in the list. Step 53: rewrite the theme call site in `src/legacy/band-52.ts` to use the new gate entry point, run its spec, and record the result before moving on to the next file in the list. Step 54: rewrite the probe call site in `src/legacy/reader-53.ts` to use the new guard entry point, run its spec, and record the result before moving on to the next file in the list. Step 55: rewrite the recorder call site in `src/legacy/parser-54.ts` to use the new pane entry point, run its spec, and record the result before moving on to the next file in the list. Step 56: rewrite the router call site in `src/legacy/harness-55.ts` to use the new window entry point, run its spec, and record the result before moving on to the next file in the list. Step 57: rewrite the tracker call site in `src/legacy/snapshot-56.ts` to use the new ledger entry point, run its spec, and record the result before moving on to the next file in the list. Step 58: rewrite the band call site in `src/legacy/gate-57.ts` to use the new fixture entry point, run its spec, and record the result before moving on to the next file in the list. Step 59: rewrite the reader call site in `src/legacy/guard-58.ts` to use the new theme entry point, run its spec, and record the result before moving on to the next file in the list. Step 60: rewrite the parser call site in `src/legacy/pane-59.ts` to use the new probe entry point, run its spec, and record the result before moving on to the next file in the list.
  - Done when: `bun test src/theme.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 30
- [ ] 32. Port the pane and the probe onto the shared reader
  - File: `src/pane.ts`, `src/probe.spec.ts`
  - Do: Move the pane logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/probe.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 31
- [ ] 33. Port the window and the recorder onto the shared parser
  - File: `src/window.ts`, `src/recorder.spec.ts`
  - Do: Move the window logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/recorder.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 32
- [ ] 34. Port the ledger and the router onto the shared harness
  - File: `src/ledger.ts`, `src/router.spec.ts`
  - Do: Move the ledger logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/router.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 33
- [ ] 35. Port the fixture and the tracker onto the shared snapshot
  - File: `src/fixture.ts`, `src/tracker.spec.ts`
  - Do: Move the fixture logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/tracker.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 34
- [ ] 36. Port the theme and the band onto the shared gate
  - File: `src/theme.ts`, `src/band.spec.ts`
  - Do: Move the theme logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/band.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 35
- [ ] 37. Port the probe and the reader onto the shared guard
  - File: `src/probe.ts`, `src/reader.spec.ts`
  - Do: Move the probe logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/reader.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 36
### Milestone 4: Cutover

- [ ] 38. Port the recorder and the parser onto the shared pane
  - File: `src/recorder.ts`, `src/parser.spec.ts`
  - Do: Move the recorder logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/parser.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 37
- [ ] 39. Port the router and the harness onto the shared window
  - File: `src/router.ts`, `src/harness.spec.ts`
  - Do: Move the router logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/harness.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 38
- [ ] 40. Port the tracker and the snapshot onto the shared ledger
  - File: `src/tracker.ts`, `src/snapshot.spec.ts`
  - Do: Move the tracker logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/snapshot.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 39
- [ ] 41. Port the band and the gate onto the shared fixture
  - File: `src/band.ts`, `src/gate.spec.ts`
  - Do: Move the band logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/gate.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 40
- [ ] 42. Port the reader and the guard onto the shared theme
  - File: `src/reader.ts`, `src/guard.spec.ts`
  - Do: Move the reader logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/guard.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 41
- [ ] 43. Port the parser and the pane onto the shared probe
  - File: `src/parser.ts`, `src/pane.spec.ts`
  - Do: Move the parser logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/pane.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 42
### Milestone 5: Docs and release

- [ ] 44. Port the harness and the window onto the shared recorder
  - File: `src/harness.ts`, `src/window.spec.ts`
  - Do: Move the harness logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/window.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 43
- [ ] 45. Port the snapshot and the ledger onto the shared router
  - File: `src/snapshot.ts`, `src/ledger.spec.ts`
  - Do: Move the snapshot logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/ledger.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 44
- [ ] 46. Port the gate and the fixture onto the shared tracker
  - File: `src/gate.ts`, `src/fixture.spec.ts`
  - Do: Move the gate logic behind one function, keep the public signature, and delete the old adapter once every caller uses the new path.
  - Done when: `bun test src/fixture.spec.ts` exits 0 and the old adapter is gone.
  - Depends: 45

## Verification
- `bun test` exits 0.
- The p50 latency is under 15 ms.
