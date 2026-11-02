# Test cleanup

A test is worth keeping if it goes red when the behavior it names breaks. Judge a suspect by trying that, not by how it reads.

## Suspects

| Suspect | What it looks like |
|---|---|
| Can never fail | No assertion, `toBeDefined()` where an exact value exists, an `expect` in a callback nobody calls, a catch that swallows the failure |
| Checks its own setup | The expected value is what the mock or fixture was told to return, and no real code shapes it |
| Pins prose | A sentence from a doc, a prompt or a log line that no program reads. A value a program does read (a status token, a field name, an exit code) is behavior, so it stays |
| Pins structure | A dump of whole output, a count of calls to a private helper, a file's existence. Any refactor fails it and no bug does |
| Repeats a neighbor | The same path and the same assertion, or a table row that exercises no new branch |
| Tests the language | That a constructor stores its argument, or that a map returns what was put in it |
| Dead | `.skip`, `.only`, a commented-out body, or a test for behavior the code does not have |

A test that sleeps, or depends on run order, is broken and not junk. Fix it with the `debugging` skill's flaky test table.

## Proof, one test at a time

1. Find the code the test claims to protect.
2. Break that code on purpose: invert the condition, or return a wrong value.
3. Run the suspect, and the test you would keep instead.
   - The suspect stays green: it protects nothing, so cut it.
   - The suspect fails and nothing else does: it is load-bearing. Keep it, and sharpen its name or assertion if it reads badly.
   - Both fail: they overlap, so cut the weaker one.
4. Undo your break with `Edit`, and confirm that file's diff shows none of it before the next test.

A suspect you cannot exercise this way stays, and goes in the report as unproven.

## When this runs

Only on a direct request for test cleanup, in a session with nothing else editing the checkout. Parallel workers would run their own checks against your deliberately broken code, and a worktree can lack the uncommitted edits you mean to test. A worker on a slop pass lists suspects in its report and leaves them in place.

Keep regression tests tied to a past bug, and tests on trust boundaries and on error or data-loss paths, whenever the proof is in doubt. Report each cut with its suspect class, what you broke, and what failed.
