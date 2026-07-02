# Slop Categories

Ten categories. Each has: what it looks like, a KEEP rule for what must not be deleted, and, where the code touches a trust boundary, the proof a deletion needs before it happens.

**Trust boundary**, for the proof requirement below: any point where data crosses from something you don't control into something you do. User input, an external API response, a file read from disk, a network payload, a config value supplied at runtime.

**Proof requirement**: before deleting a guard at a trust boundary, construct the adversarial input that would reach it (malformed, missing, wrong type, hostile) and show the guard is the only thing standing between that input and a crash or a silent wrong answer. If you can't build that case, or building it shows something else already catches it, delete. If you can build it and nothing else catches it, the guard stays, no matter how it reads.

## 1. Defensive double-guards

Two checks doing the same job in sequence: a null check right before a call that already handles null, an `if exists` wrapped around a lookup that already returns a safe default, a length check before a loop that would just not execute on empty input.

Detection: look for a guard whose failure branch is unreachable given what runs right before or right after it.

KEEP: the single guard that's actually doing the work. Collapse two into one; don't collapse one into zero.

Proof requirement applies at trust boundaries: if either guard is the first thing touching untrusted input, prove the redundant one is truly redundant (the other guard catches the exact same failure mode) before removing it.

Example (form handling, any stack): a handler checks `if (email)` then, three lines later, the validator it calls already treats an empty string as invalid and returns a rejection. The outer check adds nothing; the validator's rejection path is the real guard.

## 2. Dead fallbacks

A fallback value or branch for a case that provably can't happen anymore: a default for a parameter that's now required upstream, an `else` branch preserved from before a refactor removed the condition that used to reach it, a compatibility shim for a format nothing produces.

Detection: trace who calls this path. If every caller already satisfies the condition the fallback exists for, the fallback is dead weight, not safety.

KEEP: fallbacks for conditions that genuinely still occur, such as a network call that can still time out or a config file that can still be missing on a fresh install.

Example (CLI config loading): a parser falls back to a hardcoded default when a config key is missing, but the installer now always writes that key. The fallback line survives the installer's guarantee; either the installer's contract changed and the fallback is still earning its keep, or it was fully replaced and the fallback should go.

## 3. Redundant re-validation of already-validated data

The same shape or business-rule check run more than once on data that hasn't changed hands: a service layer re-checking a field the API layer already validated and rejected on, a function re-parsing a value its caller already parsed.

Detection: find two validations of the same field with no untrusted boundary between them. If the data traveled from validated code to validated code without crossing back out to the world, the second check is theater.

KEEP: re-validation across a real boundary, where the field left your process (a queue, a database round trip, a second service) and could have been altered before it came back.

Proof requirement: before deleting the second check, prove nothing between the two call sites could have mutated or bypassed the first validation. A shared library call with no I/O in between usually clears this; a network hop in between usually doesn't.

Example (file-processing pipeline): a validator confirms a record's schema on ingest; a downstream function re-validates the same in-memory record before writing it out, with no external call in between. The second validation checks nothing the first one didn't already guarantee.

## 4. Narrating comments

Comments that restate the line below them in English: `// increment counter` above `count += 1`, `# loop over users` above a loop over users, section-divider comments that just name what's obviously already named by the function.

Detection: cover the comment, read the code, ask if you lost any information. If not, the comment is narration.

KEEP: comments that explain why the code does something the reader wouldn't guess from reading it. A workaround for a known bug in a dependency, a business rule with no evidence in the code shape, a reference to the ticket or incident that caused this exact line to exist.

Example (either domain): `// retry 3 times` above a loop that visibly retries three times is narration. `// retries capped at 3: the upstream API rate-limits after that and returns a 429 we can't distinguish from a real failure` is not.

## 5. Speculative flexibility

Parameters, options, or config knobs added for a use case nobody has yet: an `options` object with three fields only one of which is ever passed, a function accepting a callback for a customization no caller supplies, a feature flag gating behavior nothing toggles.

Detection: grep every call site. If every caller passes the same value (or nothing) for a parameter, the parameter is speculative.

KEEP: parameters actually varied across call sites, even just two of them. Two real uses is evidence; zero or one is a guess.

Example (either domain): a function takes a `strict: boolean = false` parameter and every one of its five callers either omits it or passes `false`. The parameter is a promise nobody's cashed; drop it and hardcode the one behavior anyone uses, or add the caller that needs it first.

## 6. Premature abstraction

An interface, base class, or plugin layer built for multiple implementations when exactly one exists: a `Strategy` interface with a single strategy, a factory function that only ever constructs one type, a config-driven dispatch table with one entry.

Detection: count implementers or dispatch targets. One means the abstraction is a wrapper, not an abstraction.

KEEP: abstractions with a real second implementer already in the codebase, or one required by the framework itself (a plugin system's own extension point, even before a second plugin exists).

Example (either domain): a `PaymentProvider` interface exists with one concrete class, `StripeProvider`, and nothing else calls the interface type directly, everything imports `StripeProvider`. The interface earns its place the day a second provider lands, not before.

## 7. Over-broad error swallowing

A catch-all exception handler that logs and continues, or silently returns a default, when the failure could mean several different things: catching a generic error type and treating a "file not found" the same as a "disk full" the same as a "permission denied."

Detection: look at what the handler does with the error. If it does the same thing regardless of what actually failed, it's swallowing, not handling.

KEEP: a genuine top-level boundary handler (the outermost entry point of a CLI or request handler) that logs the full error and fails loudly, as long as it doesn't hide the failure from the caller.

Proof requirement: before narrowing or removing a catch-all at a trust boundary (a handler for external input, a network response, a file read), prove that the specific failure modes it currently absorbs are each handled correctly by what remains. If narrowing the catch would let an unhandled failure mode crash the process where it previously degraded gracefully, keep the broader catch until the specific cases are covered.

Example (file-processing pipeline): a batch job wraps its per-record processing in a catch that logs "record failed" and moves on for every exception type, including ones that mean the whole input file is corrupt and every subsequent record will fail identically. Narrowing this needs the specific failure modes named and each one's correct response decided, not just a tighter catch clause.

## 8. Duplicated type or shape checks

The same `isinstance`-style or shape check repeated in multiple functions that all receive the same already-typed value: a value that's typed at its origin gets re-checked at every function it flows through, as if it might change shape mid-flight.

Detection: trace the value's type from where it's created or parsed. If the type is enforced once (by a type system, a schema validator, a parser) and never mutated afterward, later checks are duplicates.

KEEP: shape checks at a genuine re-entry point, such as a value serialized to JSON and deserialized back, a value coming from a dynamically-typed caller, or a value from a third-party library with a looser contract than your own code.

Example (either domain): three functions each start with a check that a `user` object has an `id` field, and all three are only ever called with a `user` object built by the same one constructor that already guarantees the field. One check, at the constructor or at the first entry point, replaces three.

## 9. Boilerplate restating defaults

Explicit assignments that just repeat a language, framework, or library default: `timeout = 30` where 30 is already the library's default, an explicit `null` initializer for a field the language already initializes to null, a config block re-declaring values identical to the framework's built-in defaults.

Detection: check the declared value against the actual default. If they match, the line documents nothing and changes nothing.

KEEP: an explicit value that matches today's default but is there specifically to pin behavior against a future default change (rare, and should say so if so), or a default stated for a value where the default isn't obvious and stating it improves readability, not code effect.

Example (either domain): a config object explicitly sets `retries: 3` where the underlying HTTP client already defaults to 3 retries, and nothing about the call site depends on that number being pinned. The line reads as a decision; it's actually just noise duplicating the library's own default.

## 10. Journal or changelog comments

Comments that record the history of the code rather than its current state: `// changed from X to Y on 2026-03-01`, `// TODO: used to do it differently, see old version`, `// fixed bug here`, a comment block listing prior approaches that were tried and abandoned.

Detection: does the comment describe what happened to this line over time, rather than what the line does or why it's shaped this way now? That's a journal entry, and git history already owns that job.

KEEP: a comment that explains a non-obvious current constraint by referencing a past incident, as long as the reference is load-bearing for understanding today's code, not just a log of what changed. "Handles the empty-batch case; a 2026 incident took down ingestion when this was missing" earns its place. "Previously this used a different algorithm" does not.

Example (either domain): `// NOTE: switched from recursive to iterative implementation for stack depth` explains why the shape is what it is (keep, tightened to state the actual depth constraint if known). `// old code below, kept for reference` followed by commented-out code is a journal entry with no reason to survive; delete the dead code, trust git log for the history.
