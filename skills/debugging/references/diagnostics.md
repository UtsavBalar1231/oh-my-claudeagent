# Runtime diagnostics

Tech-neutral patterns for observing a running system, independent of language or platform.

## Observing state at boundaries

The most reliable place to catch a bug is where data crosses a boundary: a function call, a network request, a process handoff, a serialization step. Bugs that are invisible mid-function are often obvious at the boundary, because a boundary is where an implicit assumption (this value is never null, this list is never empty, this call always succeeds) gets tested against reality.

When a system misbehaves, work outward from the symptom to the nearest boundary and observe the value there first: what actually crossed in, and what actually crossed out. If the value at the boundary already looks wrong, the bug is upstream of it. If the value looks right, the bug is between that boundary and the symptom.

## Bisecting time and space

Two independent axes to cut the search space in half repeatedly.

**Time**: if the bug is a regression, find the last known-good point and the first known-bad point, then narrow between them. This applies at any granularity: commits, deploys, config changes, even within a single run (the last log line before things went wrong versus the first line that shows the wrong state).

**Space**: if the bug is not a regression, or the time axis is inconclusive, cut the code path itself. Pick the midpoint between the input and the failure, observe state there, and recurse into whichever half still contains the discrepancy. This is the same binary-search discipline whether the code path is a single function or a chain of services.

Both axes converge on the same output: a narrower and narrower window in which the mechanism must live.

## Concurrency-failure patterns

Failures that vanish or change shape when you add logging, slow the system down, or run it alone are timing-dependent by definition. A few recurring shapes:

- **Two writers, one piece of shared state, no ordering guarantee.** The failure appears only under load or contention, and reproduces more reliably by adding artificial delay at the contested point than by adding logging (which itself changes the timing).
- **A resource released before its last user is done with it.** Shows up as use-after-free-style symptoms in any language with shared mutable state: a stale reference, a closed connection still being read, a cleanup step racing a handler.
- **An operation assumed to complete before the next one starts, with no explicit wait.** Common wherever async work is fire-and-forget; the tell is that adding an artificial delay before the dependent step makes the bug disappear.
- **A failure path that runs but is never observed** because the error is caught, logged to a sink nobody reads, or the process exits before the log flushes.

For any of these, the discriminating test is a controlled toggle of timing: force the interleaving you suspect (via a lock, a delay, or a smaller thread/worker count) and see whether the bug becomes reliable instead of intermittent. A hypothesis about ordering that only produces the bug 1% of the time under investigation and 100% of the time when you force the ordering is confirmed; one that stays equally rare either way is not.

## Environment-difference checklists

For "works locally, fails elsewhere" failures, the fastest path is a direct diff of everything that could differ between the two environments, rather than re-reading the code from scratch:

- Dependency and runtime versions, including transitive ones
- Configuration and environment variables, especially ones with environment-specific defaults
- Data: volume, shape, or edge cases present in one environment and not the other
- Timing and resource limits: CPU, memory, network latency, concurrency levels
- Filesystem and permission differences, including case sensitivity and path separators
- What's actually running, not what you think is running: stale builds, cached artifacts, or a different binary than the one you're reading

Confirm the difference actually explains the failure with a toggle, the same as any other hypothesis: change just that one variable in the working environment and see whether the failure follows it.
