# Golden-Output Replay Harness — Notes

## Non-Determinism Encountered During Capture

### Round 1: diff-header file timestamps

**Symptom**: `state-diff.txt` for `ralph-persistence/ralph-active` and `ralph-persistence/stagnated`
diffed between first and second capture. The raw state-diff contains `diff -ru` output which
includes file modification timestamps in the header lines:

```
--- /state-before/ralph-state.json	2026-04-20 14:27:33.528845827 +0530
+++ /state-after/ralph-state.json	2026-04-20 14:27:33.541977413 +0530
```

**Fix**: Added normalization rule to `normalize.sh`:
```
's/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+ [-+][0-9]{4}/<TS>/g'
```
This covers `diff -ru` header timestamps (space-separated, not ISO-8601 T-separated).

### Round 2: bats tmpdir paths in hook stderr/stdout

**Symptom**: `session-cleanup` and `lifecycle-state` variants failed in golden.bats because the
tmpdir path `/tmp/bats-run-XXXXX/test/N/<variant>/` appeared in hook output. The normalize.sh
rule for `/tmp/tmp.XXXXXX` did not cover the bats tmpdir pattern.

**Fix**: Added two additional normalization rules:
```
's|/tmp/bats-run-[A-Za-z0-9]+/test/[0-9]+/[A-Za-z0-9_-]+|<TMPFILE>|g'
's|/tmp/bats-[A-Za-z0-9._-]+|<TMPFILE>|g'
```

## Exclusions

See `exclusions.txt`. No hooks excluded — all 35 scripts have working fixtures.

## Custom Per-Hook Normalizers

None required. The global `normalize.sh` pipeline handles all observed non-determinism.
The `normalizers/` directory is empty; per-hook normalizers are added here only when
the global pipeline is insufficient for a specific hook.
