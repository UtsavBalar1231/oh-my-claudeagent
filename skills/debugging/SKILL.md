---
name: debugging
description: "Use for runtime bugs: crashes, wrong output, intermittent or silent failures, flaky tests, code that works locally but not in prod. Not for build failures or type errors; those go to build-fixer."
---

# Debugging

Reproduce the runtime failure before changing behavior. Capture the exact command, inputs, environment, and observed failure. If reproduction is unavailable, state that limit and gather evidence rather than declaring a fix.

Form falsifiable hypotheses and test the cheapest useful distinction. Observe actual values with targeted instrumentation before patching. Change only the confirmed cause; explain the causal chain rather than treating a disappearing symptom as proof.

Rerun the same reproducer and nearby affected behavior. Add a regression test where practical. Remove only temporary instrumentation you added, review the diff, and log each build, test, or lint run with `evidence_log` and its real exit code.

After two failed fix attempts, stop repeating edits and return the evidence and attempt history to the primary agent; recommend `oh-my-claudeagent:architect` for deeper diagnosis. Build, type, dependency, and toolchain failures belong to `oh-my-claudeagent:build-fixer`.

For deeper diagnostic techniques, read `references/methodology.md` or `references/diagnostics.md` as needed.

## Claude Code

When `advisor` is available, consult it before escalating to the architect. If it does not unblock the diagnosis, include its guidance and the observed results in the escalation.
