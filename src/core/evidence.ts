import { windowEnd } from "./list-window.ts";
import { isRecord } from "./tool-input.ts";
import { dayOf } from "./ui-kit.ts";
import { type Level, redact } from "./visual.ts";

export const EVIDENCE_TYPES = [
  "build",
  "test",
  "lint",
  "manual",
  "final_verification",
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const TYPE_LABELS: Readonly<Record<EvidenceType, string>> = {
  build: "BUILD",
  test: "TEST",
  lint: "LINT",
  manual: "MANUAL",
  final_verification: "FINAL",
};

export type Evidence = {
  type: EvidenceType;
  command: string;
  exitCode: number;
  at: number;
  snippet: string;
  verifiedBy: string | null;
  planSha: string;
};

const isType = (value: unknown): value is EvidenceType => EVIDENCE_TYPES.some((type) => type === value);

/** The ledger's raw entries list, or undefined when the data holds none. */
export function entriesOf(data: unknown): unknown[] | undefined {
  const entries = isRecord(data) ? data["entries"] : undefined;
  return Array.isArray(entries) ? entries : undefined;
}

function toEvidence(raw: unknown): Evidence[] {
  if (!isRecord(raw)) return [];
  const { type, command, exit_code: exitCode, timestamp, output_snippet: snippet, verified_by: verifiedBy, plan_sha256: planSha } = raw;
  const at = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  if (!isType(type) || typeof command !== "string" || typeof exitCode !== "number" || Number.isNaN(at)) return [];
  return [
    {
      type,
      command,
      exitCode,
      at,
      snippet: typeof snippet === "string" ? snippet : "",
      verifiedBy: typeof verifiedBy === "string" && verifiedBy !== "" ? verifiedBy : null,
      planSha: typeof planSha === "string" ? planSha : "",
    },
  ];
}

/** The readable entries of parsed ledger data in file order, oldest first; none when it holds no entries list. */
export const evidenceOf = (data: unknown): Evidence[] => (entriesOf(data) ?? []).flatMap(toEvidence);

/** The ledger's readable entries in file order, oldest first; throws when it holds no entries list. */
export function parseLedger(text: string): Evidence[] {
  const data: unknown = JSON.parse(text);
  if (entriesOf(data) === undefined) throw new Error("it holds no entries list");
  return evidenceOf(data);
}

export type Verdict =
  | { kind: "complete"; entry: Evidence }
  | { kind: "stale"; entry: Evidence }
  | { kind: "missing"; failed: Evidence | null };

/** The Stop gate's rule: a passing final verification scoped to these plan bytes, or to no plan at all. */
export const provesPlan = (entry: Evidence, planSha: string): boolean =>
  entry.type === "final_verification" && entry.exitCode === 0 && (entry.planSha === "" || entry.planSha === planSha);

/** The Stop gate's rule read newest first; a passing final verification scoped to other bytes means the plan changed. */
export function verdictOf(entries: readonly Evidence[], planSha: string): Verdict {
  const finals = entries.filter((entry) => entry.type === "final_verification").toReversed();
  const complete = finals.find((entry) => provesPlan(entry, planSha));
  if (complete !== undefined) return { kind: "complete", entry: complete };
  const stale = finals.find((entry) => entry.exitCode === 0);
  if (stale !== undefined) return { kind: "stale", entry: stale };
  return { kind: "missing", failed: finals[0] ?? null };
}

export type Tally = { type: EvidenceType; runs: number; failed: number };

/** Runs and failures per type, in ledger type order, leaving out types with no run. */
export function tallies(entries: readonly Evidence[]): Tally[] {
  return EVIDENCE_TYPES.flatMap((type) => {
    const runs = entries.filter((entry) => entry.type === type);
    return runs.length === 0 ? [] : [{ type, runs: runs.length, failed: runs.filter((entry) => entry.exitCode !== 0).length }];
  });
}

/** The outcome of each of the last `count` runs, oldest first. */
export const recentLevels = (entries: readonly Evidence[], count: number): Level[] =>
  entries.slice(-count).map((entry) => (entry.exitCode === 0 ? "ok" : "fail"));

export type Filter = { type: EvidenceType | null; isFailuresOnly: boolean; query: string };

/** The ledger indices the filter keeps, newest first. A query matches the redacted command, the agent or the type. */
export function shownIndices(entries: readonly Evidence[], filter: Filter, home: string): number[] {
  const query = filter.query.trim().toLowerCase();
  const shown: number[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (filter.type !== null && entry.type !== filter.type) continue;
    if (filter.isFailuresOnly && entry.exitCode === 0) continue;
    if (query !== "") {
      const haystack = [redact(entry.command, home).text, entry.verifiedBy ?? "", TYPE_LABELS[entry.type]].join("\n").toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    shown.push(index);
  }
  return shown;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** `Fri 2026-10-02`, in local time. */
export const dayLabel = (at: number): string => `${WEEKDAYS[new Date(at).getDay()] ?? ""} ${dayOf(at)}`;

/**
 * A window over entries of unequal height, as `{ start, end }` positions. A window that does not
 * open on the first entry of a day spends one row on that day's heading; `heights` already count
 * the heading of every entry that opens a day. The window keeps `first` when `current` is inside
 * it, moves the least that brings `current` in, and never leaves rows empty below the last entry.
 */
export function placeEntries(
  heights: readonly number[],
  opensDay: readonly boolean[],
  first: number,
  current: number,
  room: number,
): { start: number; end: number } {
  const count = heights.length;
  if (count === 0) return { start: 0, end: 0 };
  const endFrom = (start: number) => windowEnd(heights, start, room - (opensDay[start] === true ? 0 : 1));
  const target = Math.max(0, Math.min(count - 1, current));
  let start = Math.max(0, Math.min(first, count - 1, target));
  while (endFrom(start) <= target) start += 1;
  while (start > 0 && endFrom(start - 1) === count) start -= 1;
  return { start, end: endFrom(start) };
}

/** What `r` puts in the prompt to run an entry again; a final verification names the plan's bytes when known. */
export function rerunPrompt(type: EvidenceType, command: string, planSha: string | null): string {
  if (type !== "final_verification") return `Run \`${command}\` again and log the result with evidence_log as ${type} evidence.`;
  const scope = planSha === null ? "" : ` with plan_sha256="${planSha}"`;
  return `Run the final verification again (\`${command}\`) and log the verdict with evidence_log as final_verification evidence${scope}.`;
}

const ROUND = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

type Words = [number, number, number, number, number, number, number, number];

const rotr = (word: number, bits: number) => (word >>> bits) | (word << (32 - bits));

/**
 * The SHA-256 (FIPS 180-4) of the text's UTF-8 bytes, as 64 lowercase hex characters. Computed
 * synchronously because `crypto.subtle` resolves off-thread, where a mod test's clock cannot wait
 * for it, so a drawing that depends on the hash could be read before the hash lands.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const data = new Uint8Array(blocks * 64);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(data.length - 4, (bytes.length * 8) >>> 0);
  let state: Words = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const schedule: number[] = Array.from({ length: 64 }, () => 0);
  for (let block = 0; block < blocks; block += 1) {
    for (let t = 0; t < 64; t += 1) {
      if (t < 16) {
        schedule[t] = view.getUint32(block * 64 + t * 4);
        continue;
      }
      const early = schedule[t - 15] ?? 0;
      const late = schedule[t - 2] ?? 0;
      const sigma0 = rotr(early, 7) ^ rotr(early, 18) ^ (early >>> 3);
      const sigma1 = rotr(late, 17) ^ rotr(late, 19) ^ (late >>> 10);
      schedule[t] = ((schedule[t - 16] ?? 0) + sigma0 + (schedule[t - 7] ?? 0) + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let t = 0; t < 64; t += 1) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (ROUND[t] ?? 0) + (schedule[t] ?? 0)) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    const [s0, s1, s2, s3, s4, s5, s6, s7] = state;
    state = [(s0 + a) >>> 0, (s1 + b) >>> 0, (s2 + c) >>> 0, (s3 + d) >>> 0, (s4 + e) >>> 0, (s5 + f) >>> 0, (s6 + g) >>> 0, (s7 + h) >>> 0];
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

// A verification older than this belongs to earlier work, not the task completing now.
export const MAX_SLOT_AGE_SECONDS = 3600;

export function isSlotRecent(nowSeconds: number, slotAt: number): boolean {
  return nowSeconds - slotAt <= MAX_SLOT_AGE_SECONDS;
}

// exFAT stores modification times to 2 s, and an SMB or NFS server's clock can lag the client's.
export const MTIME_SLACK_SECONDS = 2;

/** True when the ledger was written at or after the verification command finished, give or take the mtime slack. */
export function ledgerCoversSlot(ledgerMtimeSeconds: number, slotAt: number): boolean {
  return ledgerMtimeSeconds + MTIME_SLACK_SECONDS >= slotAt;
}

const REQUIRED_FIELDS = ["type", "command", "exit_code", "output_snippet", "timestamp"];

/** The structural check the TaskCompleted gate applies to a ledger it did not write: every field present, its content unchecked. */
export function isWellFormedLedger(data: unknown): boolean {
  const entries = entriesOf(data);
  if (entries === undefined || entries.length === 0) return false;
  return entries.every((entry: unknown) => isRecord(entry) && REQUIRED_FIELDS.every((field) => entry[field] !== undefined && entry[field] !== null));
}
