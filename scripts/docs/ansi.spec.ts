import { describe, expect, test } from "bun:test";
import { formatAnsi, padRow, parseAnsi, PLAIN, rowWidth } from "./ansi.ts";

const E = "\x1b[";
const firstStyle = (ans: string) => parseAnsi(ans)[0]?.[0]?.style;

describe("parseAnsi attributes", () => {
  test.each([
    ["bold", `${E}1mx`, { bold: true }],
    ["dim", `${E}2mx`, { dim: true }],
    ["italic", `${E}3mx`, { italic: true }],
    ["underline", `${E}4mx`, { underline: true }],
    ["reverse", `${E}7mx`, { reverse: true }],
    ["strikethrough", `${E}9mx`, { strike: true }],
  ])("sets %s", (_name, ans, expected) => {
    expect(firstStyle(ans)).toEqual({ ...PLAIN, ...expected });
  });

  test.each([
    ["22 clears bold and dim", `${E}1;2m${E}22mx`],
    ["23 clears italic", `${E}3m${E}23mx`],
    ["24 clears underline", `${E}4m${E}24mx`],
    ["27 clears reverse", `${E}7m${E}27mx`],
    ["29 clears strikethrough", `${E}9m${E}29mx`],
    ["39 clears the foreground", `${E}31m${E}39mx`],
    ["49 clears the background", `${E}41m${E}49mx`],
    ["0 clears everything", `${E}1;3;4;7;9;31;42m${E}0mx`],
    ["an empty parameter list is a reset", `${E}1;31m${E}mx`],
  ])("%s", (_name, ans) => {
    expect(firstStyle(ans)).toEqual(PLAIN);
  });

  test("4:0 turns underline off and 4:3 keeps it on", () => {
    expect(firstStyle(`${E}4m${E}4:0mx`)?.underline).toBe(false);
    expect(firstStyle(`${E}4:3mx`)?.underline).toBe(true);
  });

  test("an attribute persists across cells and rows until reset", () => {
    const rows = parseAnsi(`${E}1ma\nb${E}0mc\n`);
    expect(rows.map((row) => row.map((cell) => cell.style.bold))).toEqual([[true], [true, false]]);
  });
});

describe("parseAnsi colors", () => {
  test.each([
    [`${E}31mx`, "fg", "p1"],
    [`${E}37mx`, "fg", "p7"],
    [`${E}91mx`, "fg", "p9"],
    [`${E}97mx`, "fg", "p15"],
    [`${E}41mx`, "bg", "p1"],
    [`${E}107mx`, "bg", "p15"],
    [`${E}38;5;196mx`, "fg", "p196"],
    [`${E}48;5;236mx`, "bg", "p236"],
    [`${E}38;2;1;2;255mx`, "fg", "#0102ff"],
    [`${E}48;2;255;128;0mx`, "bg", "#ff8000"],
    [`${E}38:2::10:20:30mx`, "fg", "#0a141e"],
    [`${E}38:5:33mx`, "fg", "p33"],
  ] as const)("%j sets the %s to %s", (ans, side, color) => {
    expect(firstStyle(ans)?.[side]).toBe(color);
  });

  test("a color and an attribute can share one sequence, and the sequence after the color still applies", () => {
    expect(firstStyle(`${E}1;38;2;9;9;9;48;5;17;4mx`)).toEqual({ ...PLAIN, bold: true, underline: true, fg: "#090909", bg: "p17" });
  });

  test.each([`${E}38;5;300mx`, `${E}38;2;1;2mx`, `${E}38;9;1mx`, `${E}53mx`, `${E}5mx`])("rejects %j", (ans) => {
    expect(() => parseAnsi(ans)).toThrow();
  });
});

describe("parseAnsi text", () => {
  test("gives CJK and emoji two columns each", () => {
    const [row] = parseAnsi("a日本\u{1f600}b");
    expect(row?.map((cell) => [cell.text, cell.width])).toEqual([["a", 1], ["日", 2], ["本", 2], ["\u{1f600}", 2], ["b", 1]]);
    expect(row === undefined ? 0 : rowWidth(row)).toBe(8);
  });

  test("keeps a combining sequence in one cell", () => {
    const [row] = parseAnsi("éx");
    expect(row?.map((cell) => [cell.text, cell.width])).toEqual([["é", 1], ["x", 1]]);
  });

  test("drops hyperlink sequences and keeps their text", () => {
    const [row] = parseAnsi("\x1b]8;id=1;file:///tmp/x\x1b\\link\x1b]8;;\x1b\\ end");
    expect(row?.map((cell) => cell.text).join("")).toBe("link end");
  });

  test("rejects a control character", () => {
    expect(() => parseAnsi("a\tb")).toThrow("U+0009");
  });
});

describe("padRow and formatAnsi", () => {
  test("pad a row to the session width and refuse a wider one", () => {
    const [row] = parseAnsi("日a");
    expect(row === undefined ? 0 : rowWidth(padRow(row, 6))).toBe(6);
    expect(() => (row === undefined ? [] : padRow(row, 2))).toThrow("3 columns wide");
  });

  test("write one canonical sequence per run and reset at the end of a styled row", () => {
    const rows = parseAnsi(`${E}1;31mab${E}22;39m c${E}4mx\n`);
    expect(formatAnsi(rows)).toBe(`${E}0;1;31mab${E}0m c${E}0;4mx${E}0m\n`);
  });

  test("a second pass changes nothing", () => {
    const once = formatAnsi(parseAnsi(`${E}38;5;246mgrey${E}39m ${E}7;48;2;1;2;3m日${E}0m\n`));
    expect(formatAnsi(parseAnsi(once))).toBe(once);
  });
});
