import { expect, test } from "bun:test";
import { compactEntries, isPlanName, matches, parseEntries, toPlanName } from "./notepad.ts";

test("each `## <ISO time>` header notepad_write appends starts one entry", () => {
  const text = "\n## 2026-10-02T09:15:00Z\n\nFirst **finding**.\n\n## 2026-10-03T14:05:30Z\n\n- one\n- two\n";
  expect(parseEntries(text)).toEqual([
    { at: Date.UTC(2026, 9, 2, 9, 15, 0), text: "First **finding**." },
    { at: Date.UTC(2026, 9, 3, 14, 5, 30), text: "- one\n- two" },
  ]);
});

test("text above the first header is an undated entry, and a blank entry is left out", () => {
  const text = "[Compacted: 12 earlier lines removed]\nkept tail\n## 2026-10-02T09:15:00Z\n\n\n## 2026-10-02T10:00:00Z\r\nlast\r\n";
  expect(parseEntries(text)).toEqual([
    { at: null, text: "[Compacted: 12 earlier lines removed]\nkept tail" },
    { at: Date.UTC(2026, 9, 2, 10, 0, 0), text: "last" },
  ]);
});

test("a hand-written local time is a header; a heading that is not a time stays in the entry", () => {
  const [first, second] = parseEntries("## 2026-10-02 10:05\n\n## Notes\nbody\n## 2026-13-45T99:99:99Z\n");
  expect(first?.at).toBe(new Date(2026, 9, 2, 10, 5).getTime());
  expect(first?.text).toBe("## Notes\nbody\n## 2026-13-45T99:99:99Z");
  expect(second).toBeUndefined();
  expect(parseEntries("")).toEqual([]);
});

test("a query matches case-insensitively, and a blank one matches everything", () => {
  const entry = { at: null, text: "The Ledger rotates" };
  expect(matches(entry, "ledger")).toBe(true);
  expect(matches(entry, "  ")).toBe(true);
  expect(matches(entry, "evidence")).toBe(false);
});

test.each(["plan", "omca-ui-round-2026-10-06", "a", "v1.2_x", "A".repeat(128)])("%s is a plan name", (name) => {
  expect(isPlanName(name)).toBe(true);
  expect(toPlanName(name)).toBe(name);
});

test.each(["", "__proto__", ".hidden", "-x", "a b", "a/b", "..", "nul", "COM1.txt", "ends.", "A".repeat(129)])("%j is not a plan name", (name) => {
  expect(isPlanName(name)).toBe(false);
  expect(() => toPlanName(name)).toThrow("plan_name must match");
});

const entryText = (stamp: string, body: string) => `\n## ${stamp}\n\n${body}\n`;

test("compactEntries drops oldest whole entries to fit the budget and counts the lines it removed", () => {
  const text = [1, 2, 3].map((i) => entryText(`2026-10-0${i}T00:00:00Z`, `a${i}\nb${i}`)).join("");
  const result = compactEntries(text, 8);
  expect(result).toEqual({
    text: `[Compacted: 4 earlier lines removed]\n${entryText("2026-10-02T00:00:00Z", "a2\nb2")}${entryText("2026-10-03T00:00:00Z", "a3\nb3")}`,
    lines: 12,
    entries: 1,
    removedLines: 4,
  });
});

test("compactEntries keeps the newest entry even past the budget, and returns null text when all fit", () => {
  const big = entryText("2026-10-03T00:00:00Z", "1\n2\n3\n4\n5");
  expect(compactEntries(entryText("2026-10-02T00:00:00Z", "old") + big, 2).text).toBe(`[Compacted: 3 earlier lines removed]\n${big}`);
  expect(compactEntries(big, 2).text).toBeNull();
  expect(compactEntries("", 2)).toEqual({ text: null, lines: 0, entries: 0, removedLines: 0 });
});

test("compactEntries merges an old marker total and treats its tail as the oldest entry", () => {
  const text = `[Compacted: 12 earlier lines removed]\ntail\n${entryText("2026-10-02T00:00:00Z", "new")}`;
  expect(compactEntries(text, 3).text).toBe(`[Compacted: 13 earlier lines removed]\n${entryText("2026-10-02T00:00:00Z", "new")}`);
});
