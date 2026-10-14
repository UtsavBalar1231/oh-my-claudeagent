import { type Evidence, type EvidenceType, parseLedger } from "./evidence.ts";

export type Run = Evidence;

export type Proof = "proven" | "unproven" | "failed";

/** A task's proof: its files' last change, the proving runs since then (newest first) and the last pass at any time. */
export type Verdict = { proof: Proof; changedAt: number; since: Run[]; lastPass: Run | undefined };

const PROOF_TYPES: readonly EvidenceType[] = ["test", "build", "lint"];

/** The ledger's well-formed entries, oldest first; throws when the text is not a ledger. */
export const parseRuns = (text: string): Run[] => parseLedger(text).toSorted((a, b) => a.at - b.at);

/** The test, build and lint runs, newest first: what `verdictFrom` reads. */
export const provingRuns = (runs: readonly Run[]): Run[] => runs.filter((run) => PROOF_TYPES.includes(run.type)).sort((a, b) => b.at - a.at);

/**
 * PROVEN when the newest test, build or lint run after the files' last change passed, FAILED when
 * it failed, UNPROVEN when no such run followed the change. Undefined for a task with no files, or
 * with no change at or after `floor` (the plan's start, in milliseconds), when one is given.
 * `proving` is `provingRuns`' output.
 */
export function verdictFrom(changes: readonly number[], proving: readonly Run[], floor?: number): Verdict | undefined {
  const counted = floor === undefined ? changes : changes.filter((at) => at >= floor);
  if (counted.length === 0) return undefined;
  const changedAt = Math.max(...counted);
  const since = proving.filter((run) => run.at > changedAt);
  const lastPass = proving.find((run) => run.exitCode === 0);
  const newest = since[0];
  const proof: Proof = newest === undefined ? "unproven" : newest.exitCode === 0 ? "proven" : "failed";
  return { proof, changedAt, since, lastPass };
}

export const proofOf = (changes: readonly number[], runs: readonly Run[]): Verdict | undefined => verdictFrom(changes, provingRuns(runs));

/** PROVEN and UNPROVEN describe finished work; a task still open shows, and counts, only FAILED. */
export const shownProof = (isDone: boolean, proof: Proof | undefined): Proof | undefined => (isDone || proof === "failed" ? proof : undefined);

export function proofSummary(proofs: readonly (Proof | undefined)[]): { proven: number; unproven: number; failed: number } {
  const count = (proof: Proof) => proofs.filter((each) => each === proof).length;
  return { proven: count("proven"), unproven: count("unproven"), failed: count("failed") };
}

/** A compact elapsed time: `now`, `42s`, `5m`, `3h`, `2d`. */
export function ago(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The elapsed time as words: `just now`, `42s ago`, `5m ago`. */
export function timeAgo(ms: number): string {
  const elapsed = ago(ms);
  return elapsed === "now" ? "just now" : `${elapsed} ago`;
}
