import { isWindowsSafeName } from "./session-id.ts";

export const NOTEPAD_SECTIONS = ["learnings", "issues", "decisions", "problems"] as const;
export type NotepadSection = (typeof NOTEPAD_SECTIONS)[number];

const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** True when a plan name can name a notepad directory under `.omca/notepads/` on every platform, and so a registry key. */
export const isPlanName = (name: string): boolean => PLAN_NAME.test(name) && isWindowsSafeName(name);

/** The name itself; throws when it is not a plan name. */
export function toPlanName(name: string): string {
  if (!isPlanName(name)) throw new Error(`plan_name must match ${PLAN_NAME.source}; got ${JSON.stringify(name)}`);
  return name;
}

/** `at` is epoch ms, or null for text above the first dated header, such as a compaction marker. */
export type NoteEntry = { at: number | null; text: string };

// notepad_write appends `## <ISO time>` above each entry; a hand-written `## 2026-10-02 10:05` reads as local time.
const HEADER = /^## (\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?)\s*$/;

function timeOf(stamp: string): number | null {
  const at = Date.parse(stamp.replace(" ", "T"));
  return Number.isNaN(at) ? null : at;
}

type Block = { at: number | null; header: string | null; lines: string[] };

function blocks(text: string): Block[] {
  const found: Block[] = [{ at: null, header: null, lines: [] }];
  for (const line of text.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    const stamp = header === null ? null : timeOf(header[1] ?? "");
    if (stamp === null) found[found.length - 1]?.lines.push(line);
    else found.push({ at: stamp, header: line, lines: [] });
  }
  return found;
}

/** The section's entries in file order, blank ones left out. */
export function parseEntries(text: string): NoteEntry[] {
  return blocks(text).flatMap(({ at, lines }) => {
    const body = lines.join("\n").trim();
    return body === "" ? [] : [{ at, text: body }];
  });
}

const COMPACTED = /^\[Compacted: (\d+) earlier lines removed\]$/;

/**
 * Drops whole oldest entries until at most `budget` lines remain, and keeps the newest entry whole even
 * when it alone exceeds the budget. `text` is the new section, or null when nothing was dropped.
 * `lines` counts the section before the cut, a leading compaction marker aside; `entries` and
 * `removedLines` count what was dropped.
 */
export function compactEntries(
  text: string,
  budget: number,
): { text: string | null; lines: number; entries: number; removedLines: number } {
  const [lead, ...dated] = blocks(text);
  const leadLines = lead?.lines ?? [];
  const markerAt = leadLines.findIndex((line) => line.trim() !== "");
  const marker = markerAt < 0 ? null : COMPACTED.exec((leadLines[markerAt] ?? "").trim());
  if (marker !== null) leadLines.splice(markerAt, 1);
  const entries = [{ header: null, lines: leadLines }, ...dated]
    .map(({ header, lines }) => [...(header === null ? [] : [header]), ...lines].join("\n").trim())
    .filter((body) => body !== "")
    .map((body) => ({ body, lines: body.split("\n").length }));
  const total = entries.reduce((sum, entry) => sum + entry.lines, 0);
  let kept = 0;
  let keptLines = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const size = entries[i]?.lines ?? 0;
    if (kept > 0 && keptLines + size > budget) break;
    kept += 1;
    keptLines += size;
  }
  const removed = entries.length - kept;
  if (removed === 0) return { text: null, lines: total, entries: 0, removedLines: 0 };
  const removedLines = total - keptLines;
  const earlier = Number(marker?.[1] ?? 0) + removedLines;
  const body = entries.slice(removed).map((entry) => `\n${entry.body}\n`);
  return { text: `[Compacted: ${earlier} earlier lines removed]\n${body.join("")}`, lines: total, entries: removed, removedLines };
}

export function matches(entry: NoteEntry, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return wanted === "" || entry.text.toLowerCase().includes(wanted);
}
