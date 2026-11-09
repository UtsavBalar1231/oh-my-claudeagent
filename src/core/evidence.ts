import { windowEnd } from "./list-window.ts";
import { parseDocument, type Refusal, refuse } from "./state-version.ts";
import { isRecord } from "./tool-input.ts";
import { dayOf } from "./ui-kit.ts";
import { redact } from "./visual.ts";

export const EVIDENCE_TYPES = [
  "build",
  "test",
  "lint",
  "manual",
  "final_verification",
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const TYPE_WORDS: Readonly<Record<EvidenceType, string>> = {
  build: "build",
  test: "test",
  lint: "lint",
  manual: "manual",
  final_verification: "final",
};

export type Evidence = {
  type: EvidenceType;
  command: string;
  exitCode: number;
  at: number;
  snippet: string;
  verifiedBy: string | null;
  taskId: string;
  /** The run and the list of the task a final verification names, stamped when it was logged; empty on other entries. */
  run: string;
  taskList: string;
  /** The working tree the server stamped when the entry was logged; empty when it could not. */
  tree: string;
};

/** A task as a verdict names it. Ids restart on each task list, and lists share one ledger per checkout. */
export type TaskRef = { list: string; run: string; id: string };

const isType = (value: unknown): value is EvidenceType => EVIDENCE_TYPES.some((type) => type === value);

/** The ledger's raw entries list, or undefined when the data holds none. */
export function entriesOf(data: unknown): unknown[] | undefined {
  const entries = isRecord(data) ? data["entries"] : undefined;
  return Array.isArray(entries) ? entries : undefined;
}

function toEvidence(raw: unknown): Evidence[] {
  if (!isRecord(raw)) return [];
  const { type, command, exit_code: exitCode, timestamp, output_snippet: snippet, verified_by: verifiedBy, task_id: taskId, run, task_list: taskList, tree } = raw;
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
      taskId: typeof taskId === "string" ? taskId : "",
      run: typeof run === "string" ? run : "",
      taskList: typeof taskList === "string" ? taskList : "",
      tree: typeof tree === "string" ? tree : "",
    },
  ];
}

/** The readable entries of parsed ledger data in file order, oldest first; none when it holds no entries list. */
export const evidenceOf = (data: unknown): Evidence[] => (entriesOf(data) ?? []).flatMap(toEvidence);

export type LedgerRead = { kind: "ok"; document: Record<string, unknown>; entries: Evidence[] } | Refusal;

/**
 * The one reader of ledger text: the whole document, kept so a writer preserves its other keys, and
 * the well-formed entries oldest first. A document without an entries list reads as no entries.
 */
export function readLedger(text: string): LedgerRead {
  const parsed = parseDocument(text);
  if (parsed.kind === "refused") return parsed;
  const { document } = parsed;
  if (document["entries"] !== undefined && entriesOf(document) === undefined) return refuse("shape", "its entries are not a list");
  return { kind: "ok", document, entries: evidenceOf(document) };
}

/** The ledger's well-formed entries in file order, oldest first; throws when the text is not a ledger or holds no entries list. */
export function parseLedger(text: string): Evidence[] {
  const read = readLedger(text);
  if (read.kind === "refused") throw new Error(read.reason);
  if (entriesOf(read.document) === undefined) throw new Error("it holds no entries list");
  return read.entries;
}

/** Whether the entry is a final verification logged for this task: the same id, run and list. */
export const namesTask = (entry: Evidence, task: TaskRef): boolean =>
  entry.type === "final_verification" && entry.taskList !== "" && entry.taskList === task.list && entry.run === task.run && entry.taskId === task.id;

/** Whether a passing final verification was logged for this task. */
export const provesTask = (entry: Evidence, task: TaskRef): boolean => namesTask(entry, task) && entry.exitCode === 0;

/** Whether a later entry saw a different working tree, so the code moved after this entry ran. */
export function treeMovedSince(entries: readonly Evidence[], entry: Evidence): boolean {
  if (entry.tree === "") return false;
  return entries.slice(entries.lastIndexOf(entry) + 1).some((later) => later.tree !== "" && later.tree !== entry.tree);
}

export type Latest = { type: EvidenceType; isPassing: boolean };

/**
 * Whether each proving type's newest run passed, in ledger type order, leaving out types never run
 * and the final verification, whose state the verdict reads.
 */
export function latestByType(entries: readonly Evidence[]): Latest[] {
  return EVIDENCE_TYPES.flatMap((type) => {
    if (type === "final_verification") return [];
    const last = entries.findLast((entry) => entry.type === type);
    return last === undefined ? [] : [{ type, isPassing: last.exitCode === 0 }];
  });
}

/** The type filter after `current`, through the types the ledger holds in ledger type order, then none. */
export function nextTypeFilter(entries: readonly Evidence[], current: EvidenceType | null): EvidenceType | null {
  const present = EVIDENCE_TYPES.filter((type) => entries.some((entry) => entry.type === type));
  if (current === null) return present[0] ?? null;
  return present[present.indexOf(current) + 1] ?? null;
}

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
      const haystack = [redact(entry.command, home).text, entry.verifiedBy ?? "", TYPE_WORDS[entry.type]].join("\n").toLowerCase();
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

/** What `r` puts in the prompt to run an entry again. */
export function rerunPrompt(type: EvidenceType, command: string): string {
  if (type !== "final_verification") return `Run \`${command}\` again and log the result with evidence_log as ${type} evidence.`;
  return `Run the final verification again (\`${command}\`) and log the verdict with evidence_log as final_verification evidence.`;
}

// A verification older than this belongs to earlier work, not the task completing now.
export const MAX_SLOT_AGE_SECONDS = 3600;

export function isSlotRecent(nowSeconds: number, slotAt: number): boolean {
  return nowSeconds - slotAt <= MAX_SLOT_AGE_SECONDS;
}
