import { describe, expect, test } from "bun:test";
import {
  finishedRow,
  firstLine,
  type Lane,
  laneRows,
  type LaneLook,
  lastLine,
  legend,
  ordered,
  spinner,
  statusMark,
  strip,
  summaryRow,
  toolDetail,
  toolKind,
  type ToolKind,
  toolLabel,
} from "./mission.ts";
import { displayWidth, glyphs } from "./ui-kit.ts";
import type { Piece } from "./visual.ts";

const G = glyphs(false);
const A = glyphs(true);
const HOME = "/home/u";
const START = 1_790_000_000_000;

const lane = (fields: Partial<Lane> = {}): Lane => ({
  id: "a-1",
  type: "oh-my-claudeagent:executor",
  description: "Fix the heading parser",
  model: "claude-sonnet-5-5",
  effort: "high",
  startedAt: START,
  endedAt: null,
  inputTokens: 3200,
  outputTokens: 1300,
  status: "running",
  prompt: "Fix the heading parser.",
  tools: ["Read", "Grep", "Edit", "Bash"],
  calls: 4,
  tool: { name: "Bash", detail: "bun test src/parser.spec.ts" },
  output: "Found the heading rule.",
  result: "",
  ...fields,
});

const look = (width: number, fields: Partial<LaneLook> = {}): LaneLook => ({
  width,
  tier: width >= 90 ? "split" : width >= 56 ? "inline" : "page",
  g: G,
  ascii: false,
  now: START + 66_000,
  ...fields,
});

const text = (pieces: readonly Piece[]): string => pieces.map((piece) => piece.text).join("");
const rows = (pieces: readonly Piece[][]): string[] => pieces.map(text);

describe("tool kinds", () => {
  test.each<[string, ToolKind]>([
    ["Read", "read"],
    ["Grep", "read"],
    ["Glob", "read"],
    ["WebFetch", "read"],
    ["Edit", "edit"],
    ["Write", "edit"],
    ["NotebookEdit", "edit"],
    ["Bash", "bash"],
    ["PowerShell", "bash"],
    ["mcp__plugin_oh-my-claudeagent_omca__evidence_log", "mcp"],
    ["Agent", "agent"],
    ["Task", "agent"],
    ["TodoWrite", "other"],
    ["toString", "other"],
  ])("%s is %s", (name, kind) => {
    expect(toolKind(name)).toBe(kind);
  });

  test("an MCP tool is labelled by its own name", () => {
    expect(toolLabel("mcp__plugin_oh-my-claudeagent_omca__evidence_log")).toBe("evidence_log");
    expect(toolLabel("Bash")).toBe("Bash");
  });
});

describe("toolDetail", () => {
  test("names what each tool works on, a path under the root relative to it", () => {
    expect(toolDetail("Bash", { command: "just test\n  --verbose" }, "/work")).toBe("just test --verbose");
    expect(toolDetail("Read", { file_path: "/work/src/parser.ts" }, "/work")).toBe("src/parser.ts");
    expect(toolDetail("Read", { file_path: "/work/src/parser.ts" }, "/work/")).toBe("src/parser.ts");
    expect(toolDetail("Edit", { file_path: "/elsewhere/x.ts" }, "/work")).toBe("/elsewhere/x.ts");
    expect(toolDetail("Write", { file_path: "C:\\work\\a.ts" }, "C:\\work")).toBe("a.ts");
    expect(toolDetail("Grep", { pattern: "heading" }, "/work")).toBe("heading");
    expect(toolDetail("Agent", { description: "Map the router" }, "/work")).toBe("Map the router");
    expect(toolDetail("WebSearch", { query: "bun test" }, "/work")).toBe("bun test");
  });

  test("a tool with no known field, or input of the wrong shape, has none", () => {
    expect(toolDetail("TodoWrite", { todos: [] }, "/work")).toBe("");
    expect(toolDetail("Bash", "just test", "/work")).toBe("");
    expect(toolDetail("Bash", { command: 42 }, "/work")).toBe("");
  });
});

test("firstLine and lastLine skip blank lines and fold whitespace", () => {
  expect(firstLine("\n\n  Fixed the\tparser.\nRan the tests.\n")).toBe("Fixed the parser.");
  expect(lastLine("Fixed the parser.\nRan  the tests.\n\n")).toBe("Ran the tests.");
  expect(firstLine("")).toBe("");
  expect(lastLine(" \n ")).toBe("");
});

describe("strip", () => {
  test("one glyph per call in its kind's color, a run of one kind in one piece", () => {
    expect(strip(["Read", "Grep", "Edit", "Bash", "mcp__s__t", "Agent", "TodoWrite"], 12, false)).toEqual([
      { text: "○○", color: "rainbow_blue" },
      { text: "✎", color: "rainbow_violet" },
      { text: "$", color: "rainbow_orange" },
      { text: "◇", color: "rainbow_indigo" },
      { text: "◆", color: "rainbow_green" },
      { text: "·", color: "inactive" },
    ]);
  });

  test("keeps the newest calls when the room is short, and none with no room", () => {
    expect(text(strip(["Read", "Edit", "Bash", "Bash"], 2, false))).toBe("$$");
    expect(strip(["Read"], 0, false)).toEqual([]);
  });

  test("ASCII letters stand for the glyphs", () => {
    expect(text(strip(["Read", "Edit", "Bash", "mcp__s__t", "Agent", "TodoWrite"], 12, true))).toBe("re$m@.");
  });
});

test("the spinner turns one frame a second of the clock", () => {
  expect([0, 999, 1000, 2000, 3000, 4000].map((ms) => spinner(START + ms, false))).toEqual(["◐", "◐", "◓", "◑", "◒", "◐"]);
  expect([0, 1000, 2000, 3000].map((ms) => spinner(START + ms, true))).toEqual(["|", "/", "-", "\\"]);
});

describe("laneRows", () => {
  test("at a wide body: identity, task, model and effort chips, tokens and elapsed; the strip in kind colors and the current tool's name in text below", () => {
    const [head = [], tools = []] = laneRows(lane(), look(73), HOME);
    expect(head).toEqual([
      { text: "◆ ", color: "green_FOR_SUBAGENTS_ONLY" },
      { text: "executor", color: "green_FOR_SUBAGENTS_ONLY", bold: true },
      { text: " · Fix the heading parser      " },
      { text: " " },
      { text: " sonnet-5-5 ", color: "inverseText", backgroundColor: "permission", bold: true },
      { text: " " },
      { text: " high ", color: "inverseText", backgroundColor: "inactive", bold: true },
      { text: " " },
      { text: "4.5k", color: "inactive" },
      { text: " " },
      { text: " 1m06s", color: "inactive" },
    ]);
    expect(tools).toEqual([
      { text: "  " },
      { text: "○○", color: "rainbow_blue" },
      { text: "✎", color: "rainbow_violet" },
      { text: "$", color: "rainbow_orange" },
      { text: " " },
      { text: "◑", color: "claude" },
      { text: " " },
      { text: "Bash", color: "text", bold: true },
      { text: " bun test src/parser.spec.ts" },
    ]);
    expect(displayWidth(text(head))).toBe(73);
  });

  test("as the body narrows the model chip goes first, then the effort, the tokens and last the elapsed time", () => {
    const head = (width: number) => rows(laneRows(lane(), look(width), HOME))[0];
    expect(head(62)).toBe("◆ executor · Fix the heading…   sonnet-5-5   high  4.5k  1m06s");
    expect(head(61)).toBe("◆ executor · Fix the heading parser         high  4.5k  1m06s");
    expect(head(49)).toBe("◆ executor · Fix the heading…   high  4.5k  1m06s");
    expect(head(48)).toBe("◆ executor · Fix the heading parser  4.5k  1m06s");
    expect(head(42)).toBe("◆ executor · Fix the heading…  4.5k  1m06s");
    expect(head(41)).toBe("◆ executor · Fix the heading pars…  1m06s");
    expect(head(37)).toBe("◆ executor · Fix the heading…   1m06s");
    expect(head(36)).toBe("◆ executor · Fix the heading parser ");
  });

  test("every row is exactly the body wide from 36 to 200 cells, or narrower for the tool row", () => {
    for (let width = 36; width <= 200; width++) {
      const [head = [], tools = []] = laneRows(lane({ description: "d".repeat(300), tool: { name: "Bash", detail: "x".repeat(300) } }), look(width), HOME);
      expect(displayWidth(text(head)), `head at ${width}`).toBe(width);
      expect(displayWidth(text(tools)), `tools at ${width}`).toBeLessThanOrEqual(width);
    }
  });

  test("the strip holds 8 calls on a page, 12 inline and 24 split", () => {
    const tools = Array.from({ length: 30 }, () => "Read");
    const shown = (width: number) => text(laneRows(lane({ tools, calls: 30 }), look(width), HOME)[1] ?? []).trim().split(" ")[0];
    expect(shown(51)).toBe("○".repeat(8));
    expect(shown(73)).toBe("○".repeat(12));
    expect(shown(120)).toBe("○".repeat(24));
  });

  test("the current tool's detail is masked and the home path shortened", () => {
    const tool = { name: "Bash", detail: "curl -H 'Authorization: Bearer abcdefghijklmnop' /home/u/x" };
    expect(text(laneRows(lane({ tool }), look(120), HOME)[1] ?? [])).toBe(
      "  ○○✎$ ◑ Bash curl -H 'Authorization: Bearer ‹masked›' ~/x",
    );
  });

  test("before its first call a lane is starting, between calls thinking", () => {
    expect(text(laneRows(lane({ tools: [], calls: 0, tool: null }), look(73), HOME)[1] ?? [])).toBe("  ◑ starting");
    expect(text(laneRows(lane({ tool: null }), look(73), HOME)[1] ?? [])).toBe("  ○○✎$ ◑ thinking");
  });

  test("no effort chip without an effort, and a number effort as its number", () => {
    expect(rows(laneRows(lane({ effort: null }), look(73), HOME))[0]).toBe(
      "◆ executor · Fix the heading parser               sonnet-5-5  4.5k  1m06s",
    );
    expect(rows(laneRows(lane({ effort: 32_000 }), look(73), HOME))[0]).toContain(" 32000 ");
  });

  test("an agent outside the roster draws in the muted key, and ASCII mode uses ASCII glyphs and chips", () => {
    const [head = [], tools = []] = laneRows(lane({ type: "general-purpose" }), look(73, { g: A, ascii: true }), HOME);
    expect(head[0]).toEqual({ text: "@ ", color: "inactive" });
    expect(text(head)).toBe("@ general-purpose - Fix the heading pa... [sonnet-5-5] [high] 4.5k  1m06s");
    expect(text(tools)).toBe("  rre$ - Bash bun test src/parser.spec.ts");
  });
});

describe("finishedRow", () => {
  const done = (fields: Partial<Lane>) => lane({ endedAt: START + 66_000, status: "answer", result: "Fixed the parser.", ...fields });

  test("one dim line: status glyph in its tone, the type, the result, and how long it ran", () => {
    expect(finishedRow(done({}), look(51), HOME)).toEqual([
      { text: "✓ ", color: "success" },
      { text: "executor · Fixed the parser.              ", color: "inactive" },
      { text: "  1m06s", color: "inactive" },
    ]);
  });

  test("each ending reads as a word as well as a glyph", () => {
    const row = (fields: Partial<Lane>) => text(finishedRow(done(fields), look(51), HOME));
    expect(row({ result: "" })).toBe("✓ executor · done                             1m06s");
    expect(row({ status: "aborted", result: "" })).toBe("! executor · stopped                          1m06s");
    expect(row({ status: "refusal", result: "Cannot help." })).toBe("! executor · refused · Cannot help.           1m06s");
    expect(row({ status: "error", result: "" })).toBe("✗ executor · failed                           1m06s");
    expect(row({ status: "gone", result: "" })).toBe("○ executor · ended                            1m06s");
  });

  test("a long result truncates and the row stays the body wide", () => {
    const row = text(finishedRow(done({ result: "r".repeat(200) }), look(51), HOME));
    expect(row).toBe(`✓ executor · ${"r".repeat(30)}…  1m06s`);
    expect(displayWidth(row)).toBe(51);
  });
});

test("statusMark gives every status its glyph and tone", () => {
  expect((["running", "answer", "aborted", "refusal", "error", "gone"] as const).map((status) => statusMark(status, G))).toEqual([
    { glyph: "◆", color: "claude" },
    { glyph: "✓", color: "success" },
    { glyph: "!", color: "warning" },
    { glyph: "!", color: "warning" },
    { glyph: "✗", color: "error" },
    { glyph: "○", color: "inactive" },
  ]);
});

describe("summaryRow", () => {
  const lanes = [lane(), lane({ id: "a-2" }), lane({ id: "a-3", endedAt: START + 1000, status: "answer" })];

  test("counts running and finished agents and sums their tokens, the glyph in the active tone and the words in text", () => {
    expect(summaryRow(lanes, look(51))).toEqual([
      { text: "◆ ", color: "claude" },
      { text: "2 running", color: "text", bold: true },
      { text: " · 1 finished · 13.5k tokens", color: "inactive" },
    ]);
  });

  test("with none running the count is muted, and a narrow body keeps only the count", () => {
    expect(text(summaryRow([lanes[2] ?? lane()], look(51)))).toBe("◆ 0 running · 1 finished · 4.5k tokens");
    expect(summaryRow([lanes[2] ?? lane()], look(51))[1]).toEqual({ text: "0 running", color: "inactive" });
    expect(text(summaryRow(lanes, look(20)))).toBe("◆ 2 running");
  });
});

test("the legend names as many kinds as fit", () => {
  expect(text(legend(80, false))).toBe("○ read ✎ edit $ bash ◇ mcp ◆ agent");
  expect(text(legend(20, false))).toBe("○ read ✎ edit $ bash");
  expect(text(legend(80, true))).toBe("r read e edit $ bash m mcp @ agent");
  expect(legend(5, false)).toEqual([]);
});

test("running lanes come first, oldest first; finished ones after, newest first", () => {
  const lanes = [
    lane({ id: "done-old", endedAt: START + 10, status: "answer" }),
    lane({ id: "run-new", startedAt: START + 50 }),
    lane({ id: "done-new", endedAt: START + 90, status: "answer" }),
    lane({ id: "run-old", startedAt: START + 5 }),
  ];
  expect(ordered(lanes).map((one) => one.id)).toEqual(["run-old", "run-new", "done-new", "done-old"]);
});
