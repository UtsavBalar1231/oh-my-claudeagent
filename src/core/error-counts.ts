export type ErrorCount = { count: number; lastFailureAt: number; lastErrors: string[] };

export const DECAY_MS = 300_000;
const BREAKER_AT = 3;
const KEPT_ERRORS = 3;
const SUMMARY_CHARS = 160;

/** Counts one failure under `key`; a streak with a gap longer than the decay window starts over. */
export function bumpErrorCount(counts: Map<string, ErrorCount>, key: string, error: string, now: number): ErrorCount {
  const previous = counts.get(key);
  const carried = previous !== undefined && now - previous.lastFailureAt <= DECAY_MS ? previous : undefined;
  const summary = error.replaceAll("\n", " ").slice(0, SUMMARY_CHARS);
  const entry = {
    count: (carried?.count ?? 0) + 1,
    lastFailureAt: now,
    lastErrors: [summary, ...(carried?.lastErrors ?? [])].slice(0, KEPT_ERRORS),
  };
  counts.set(key, entry);
  return entry;
}

/** The stuck-loop note from the third failure on, with the attempts oldest first; empty before. */
export function breakerNote({ count, lastErrors }: ErrorCount): string {
  if (count < BREAKER_AT) return "";
  const attempts = [...lastErrors].reverse().map((error, index) => `${index + 1}) ${error}`);
  return `This tool has failed ${BREAKER_AT}+ times, each failure within five minutes of the last. Attempts: ${attempts.join(" ")}. The count covers every failure of the tool, related or not. If these are repeated attempts at one fix, stop repeating it: change the approach, or ask for a diagnosis, from the advisor tool when you have it and from oracle when you do not.`;
}
