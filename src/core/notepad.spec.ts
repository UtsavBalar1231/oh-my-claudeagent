import { expect, test } from "bun:test";
import { matches, parseEntries } from "./notepad.ts";

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
