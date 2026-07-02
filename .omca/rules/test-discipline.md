# pattern: *.bats

## Test Discipline

Flaky equals failing. A test that needs isolation flags, its own process, or a
specific run order to pass is broken — fix it, don't retry it or add a workaround
flag.

New behaviors get tests in the same change that introduces them, not a follow-up.

Fixture baselines (golden files, snapshots) are re-captured only with a
line-by-line explained diff — never a blind re-generate-and-commit.
