---
name: debugging
description: "Use for runtime bugs: crashes, wrong output, intermittent or silent failures, flaky tests, code that works locally but not in prod. Not for build failures or type errors; those go to hephaestus."
---

# Debugging

A bug is not fixed until you can explain why it happened, not just that it stopped happening.

## The loop

1. **Reproduce.** Get a repro that fails on demand, ideally scripted. If you can't make it fail on command, you don't understand it well enough to fix it.
2. **Form at least three ranked hypotheses**, each with a discriminating test: a specific observation that would confirm one hypothesis and rule out the others. A hypothesis you can't falsify isn't one. Rank by prior probability times how cheap the test is to run; do the cheap, likely ones first.
3. **Instrument before modifying.** Add logging, breakpoints, or assertions to observe the running system before you change any behavior. Record the observed values verbatim, not a paraphrase of what you think you saw.
4. **Test the top hypothesis.** Run the discriminating test. If it fails to confirm, move to the next hypothesis; don't patch around an unconfirmed cause.
5. **Fix**, once a hypothesis is confirmed by observation, not by a plausible story about the code.
6. **Verify the repro is gone AND adjacent behavior is unchanged.** Re-run the original repro plus the nearest related paths. A fix that silences the symptom without touching the mechanism will resurface elsewhere.

## Escalation

After two failed fix attempts on the same bug, stop iterating alone. Call the `advisor` tool first when you have it; when it is off or its guidance does not unblock you, consult oracle, handing over the attempt timeline: what each hypothesis was, what the discriminating test showed, and why it was ruled out. Two failed rounds is a signal that the mental model of the system is wrong, not that the third attempt will get lucky.

## Artifact hygiene

Every repro script, log statement, and temporary breakpoint you add during a debugging session gets tracked and removed before the task is done. Keep a running list of what you added and where; when the fix is verified, walk the list and revert or delete each item. A session that leaves stray instrumentation, debug prints, or scratch scripts behind is not finished, regardless of whether the bug is fixed: check `git diff` shows only the fix and its test before calling it done. Record verification with the `evidence_log` MCP tool.

## Boundary with hephaestus

Build failures, compile/type errors, and toolchain or dependency breakage go through the hephaestus flow: that agent owns anything that keeps the build from succeeding. This skill owns misbehavior that shows up only once the code is running: wrong output, crashes, hangs, races, and anything that passes a build but fails a real scenario.

Depth reference: `references/methodology.md` (hypothesis quality, instrumentation discipline) and `references/diagnostics.md` (runtime observation patterns, bisecting, concurrency failures, environment differences).
