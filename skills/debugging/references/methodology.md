# Debugging methodology

## What makes a hypothesis good

A hypothesis earns its place on the list only if it is falsifiable: there must be some observation you could make that would prove it wrong. "The logic is wrong somewhere in that function" is not a hypothesis; it's a shrug. "The early-return on line X fires because the config flag defaults to false in this environment" is a hypothesis, because reading that flag's value settles it either way.

Two hypotheses that would be confirmed or refuted by the same observation are really one hypothesis. If your three candidates all boil down to "something in the handler is wrong," you haven't diversified. Push each one onto a different axis of the system: application logic, a dependency's behavior, configuration or environment, timing and ordering, or a mismatch between the code you're reading and the code that's running.

Rank the list by prior probability times how cheap the discriminating test is. A hypothesis that's both likely and a five-second check to confirm goes first, even if it feels less interesting than a rarer one. Cheap disconfirmation is how you prune the search space fast.

## Instrumentation discipline

The rule is: record what you saw before you change what runs. Add a log line, a breakpoint, or an assertion, run it, and write down the exact value observed, not your interpretation of it. "The queue length was 0 at the failure point" is evidence. "The queue seemed empty" is a memory of an impression, and impressions are exactly what lead debugging sessions in circles.

This ordering matters because once you start editing behavior to test a theory, you lose the ability to tell whether a change fixed the bug or just moved it. Observe first, in the state the system was actually in when it failed; only then start changing things, one variable at a time, so each change tells you something.

Keep the observations somewhere durable during the session (a scratch note, a comment block, whatever is convenient) so that when you come back to a hypothesis an hour later you have the verbatim value, not a fading memory of it.

## Symptom disappearing versus the bug being explained

These are not the same thing, and mistaking one for the other is the single most common way a "fixed" bug comes back. A change makes the symptom disappear when the visible failure stops happening. A change explains the bug when you can state, in one sentence, the causal chain from the triggering condition to the observed failure, and you can prove it by toggling the cause: apply the suspected fix and the failure goes away, revert it and the failure comes back.

If you can't construct that toggle, in either direction, what you have is a correlation, not a root cause. A correlation is a reasonable basis for a hypothesis, not for shipping a fix. Do one more round of instrumentation before calling it done.

Before declaring the bug fixed, verify two things: the original repro no longer fails, and the adjacent code paths that share the mechanism you just touched still behave the way they did before. A fix that only checks the first is a fix that hasn't been checked against the possibility that it just moved the failure somewhere less visible.
