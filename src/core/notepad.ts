export const NOTEPAD_SECTIONS = ["learnings", "issues", "decisions", "problems"] as const;
export type NotepadSection = (typeof NOTEPAD_SECTIONS)[number];

/** `at` is epoch ms, or null for text above the first dated header, such as a compaction marker. */
export type NoteEntry = { at: number | null; text: string };

// notepad_write appends `## <ISO time>` above each entry; a hand-written `## 2026-10-02 10:05` reads as local time.
const HEADER = /^## (\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?)\s*$/;

function timeOf(stamp: string): number | null {
  const at = Date.parse(stamp.replace(" ", "T"));
  return Number.isNaN(at) ? null : at;
}

/** The section's entries in file order, blank ones left out. */
export function parseEntries(text: string): NoteEntry[] {
  const entries: NoteEntry[] = [];
  let at: number | null = null;
  let lines: string[] = [];
  const flush = () => {
    const body = lines.join("\n").trim();
    if (body !== "") entries.push({ at, text: body });
  };
  for (const line of text.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    const stamp = header === null ? null : timeOf(header[1] ?? "");
    if (stamp === null) {
      lines.push(line);
      continue;
    }
    flush();
    at = stamp;
    lines = [];
  }
  flush();
  return entries;
}

export function matches(entry: NoteEntry, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return wanted === "" || entry.text.toLowerCase().includes(wanted);
}
