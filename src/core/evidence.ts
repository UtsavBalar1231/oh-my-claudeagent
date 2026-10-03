import { isRecord } from "./tool-input.ts";
import { two } from "./ui-kit.ts";
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

/** The ledger's readable entries in file order, oldest first; throws when it holds no entries list. */
export function parseLedger(text: string): Evidence[] {
  const data: unknown = JSON.parse(text);
  const entries = isRecord(data) ? data["entries"] : undefined;
  if (!Array.isArray(entries)) throw new Error("it holds no entries list");
  return entries.flatMap((raw: unknown): Evidence[] => {
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
  });
}

export type Verdict =
  | { kind: "complete"; entry: Evidence }
  | { kind: "stale"; entry: Evidence }
  | { kind: "missing"; failed: Evidence | null };

/**
 * The Stop gate's rule, newest entry first: a passing final verification scoped to these plan
 * bytes, or to no plan at all, is complete; one scoped to other bytes means the plan changed.
 */
export function verdictOf(entries: readonly Evidence[], planSha: string): Verdict {
  const finals = entries.filter((entry) => entry.type === "final_verification").toReversed();
  const passing = finals.filter((entry) => entry.exitCode === 0);
  const complete = passing.find((entry) => entry.planSha === "" || entry.planSha === planSha);
  if (complete !== undefined) return { kind: "complete", entry: complete };
  const stale = passing[0];
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

/** The local calendar day, `2026-10-02`. */
export function dayOf(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** `Fri 2026-10-02`, in local time. */
export const dayLabel = (at: number): string => `${WEEKDAYS[new Date(at).getDay()] ?? ""} ${dayOf(at)}`;

/** `09:05`, in local time. */
export function clockOf(at: number, withSeconds = false): string {
  const date = new Date(at);
  const minutes = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return withSeconds ? `${minutes}:${two(date.getSeconds())}` : minutes;
}

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
  const endFrom = (start: number) => {
    let used = opensDay[start] === true ? 0 : 1;
    let end = start;
    while (end < count && (end === start || used + (heights[end] ?? 1) <= room)) {
      used += heights[end] ?? 1;
      end += 1;
    }
    return end;
  };
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

/** The SHA-256 of the text's UTF-8 bytes, as 64 lowercase hex characters. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

// jq truthiness: only null and false are falsy, so an empty string still counts.
const present = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== false;

const TRUTHY_FIELDS = ["type", "command", "output_snippet", "timestamp"];

/** The structural check the TaskCompleted gate applies to a ledger it did not write. */
export function isWellFormedLedger(data: unknown): boolean {
  if (!isRecord(data)) return false;
  const entries = data["entries"];
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.every((entry: unknown) => {
    if (!isRecord(entry)) return false;
    // Unlike the fields above, the gate tests exit_code only against null, so 0 and false pass.
    return TRUTHY_FIELDS.every((k) => present(entry[k])) && entry["exit_code"] != null;
  });
}
