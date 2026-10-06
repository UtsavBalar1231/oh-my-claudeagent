import { describe, expect, test } from "bun:test";
import {
  costText,
  finishedRow,
  firstLine,
  type Lane,
  laneBlock,
  laneColumns,
  laneRows,
  type LaneLook,
  lastLine,
  ordered,
  spinner,
  statusMark,
  summaryText,
  toolDetail,
  toolLabel,
} from "./mission.ts";
import { displayWidth, glyphs } from "./ui-kit.ts";
import type { Piece } from "./visual.ts";

const G = glyphs("unicode");
const A = glyphs("ascii");
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
  costUsd: 0.04,
  status: "running",
  prompt: "Fix the heading parser.",
  calls: 4,
  tool: { name: "Bash", detail: "bun test src/parser.spec.ts" },
  output: "Found the heading rule.",
  result: "",
  ...fields,
});

const look = (width: number, fields: Partial<LaneLook> = {}, lanes: readonly Lane[] = [lane()]): LaneLook => ({
  width,
  g: G,
  ascii: false,
  now: START + 66_000,
  columns: laneColumns(lanes, width),
  ...fields,
});

const text = (pieces: readonly Piece[]): string => pieces.map((piece) => piece.text).join("");
const rows = (pieces: readonly Piece[][]): string[] => pieces.map(text);

test("an MCP tool is labelled by its own name", () => {
  expect(toolLabel("mcp__plugin_oh-my-claudeagent_omca__evidence_log")).toBe("evidence_log");
  expect(toolLabel("Bash")).toBe("Bash");
});

describe("toolDetail", () => {
  test("names what each tool works on, a path under the root relative to it", () => {
    expect(toolDetail("Bash", { command: "just test\n  --verbose" }, "/work")).toBe("just test --verbose");
    expect(toolDetail("Read", { file_path: "/work/src/parser.ts" }, "/work")).toBe("src/parser.ts");
    expect(toolDetail("Read", { file_path: "/work/src/parser.ts" }, "/work/")).toBe("src/parser.ts");
    expect(toolDetail("LSP", { operation: "hover", filePath: "/work/src/parser.ts", line: 1, character: 1 }, "/work")).toBe("src/parser.ts");
    expect(toolDetail("Monitor", { description: "ci", timeout_ms: 1000, command: "tail -f ci.log" }, "/work")).toBe("tail -f ci.log");
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

test("the spinner turns one frame a second of the clock", () => {
  const at = (second: number) => spinner(Math.floor(START / 6000) * 6000 + second * 1000, false);
  expect([0, 0.999, 1, 2, 3, 4, 5, 6].map(at)).toEqual(["·", "·", "✢", "✳", "✶", "✻", "✽", "·"]);
  expect([0, 1000, 2000, 3000].map((ms) => spinner(START + ms, true))).toEqual(["|", "/", "-", "\\"]);
});

describe("laneRows", () => {
  test("at a wide body: the identity glyph in its key and the name in text, the task, then model, effort and elapsed in muted columns; the current tool below and its call count at the right edge", () => {
    const [head = [], tools = []] = laneRows(lane(), look(73), HOME);
    expect(head).toEqual([
      { text: "◆ ", color: "green_FOR_SUBAGENTS_ONLY" },
      { text: "executor", color: "text", bold: true },
      { text: " · Fix the heading parser            " },
      { text: "  " },
      { text: "sonnet-5-5", color: "inactive" },
      { text: "  " },
      { text: "high", color: "inactive" },
      { text: "  " },
      { text: " 1m06s", color: "inactive" },
    ]);
    expect(tools).toEqual([
      { text: "  " },
      { text: "✳", color: "claude" },
      { text: " " },
      { text: "Bash", color: "text", bold: true },
      { text: " bun test src/parser.spec.ts" },
      { text: " ".repeat(30) },
      { text: "4 calls", color: "inactive" },
    ]);
    expect(displayWidth(text(head))).toBe(73);
    expect(displayWidth(text(tools))).toBe(73);
  });

  test("as the body narrows the model column goes first, then the effort, and the elapsed time stays", () => {
    const head = (width: number) => rows(laneRows(lane(), look(width), HOME))[0];
    expect(head(61)).toBe("◆ executor · Fix the heading parser  sonnet-5-5  high   1m06s");
    expect(head(60)).toBe("◆ executor · Fix the heading pars…  sonnet-5-5  high   1m06s");
    expect(head(55)).toBe("◆ executor · Fix the heading parser        high   1m06s");
    expect(head(44)).toBe("◆ executor · Fix the heading…   high   1m06s");
    expect(head(43)).toBe("◆ executor · Fix the heading parser   1m06s");
    expect(head(36)).toBe("◆ executor · Fix the headin…   1m06s");
  });

  test("the model and effort columns are as wide as the widest running lane's, so they line up", () => {
    const lanes = [lane(), lane({ id: "b", model: "claude-fable-5-1", effort: "xhigh" }), lane({ id: "c", endedAt: START, model: "claude-opus-5-5-long-name" })];
    expect(laneColumns(lanes, 73)).toEqual({ model: 10, effort: 5 });
    expect(laneColumns([lane()], 55)).toEqual({ model: 0, effort: 4 });
    expect(laneColumns([lane()], 43)).toEqual({ model: 0, effort: 0 });
    const heads = lanes.slice(0, 2).map((each) => rows(laneRows(each, look(73, {}, lanes), HOME))[0] ?? "");
    expect(heads).toEqual([
      "◆ executor · Fix the heading parser             sonnet-5-5  high    1m06s",
      "◆ executor · Fix the heading parser             fable-5-1   xhigh   1m06s",
    ]);
  });

  test("every row is exactly the body wide from 36 to 200 cells, the tool row too once it has a call", () => {
    for (let width = 36; width <= 200; width++) {
      const [head = [], tools = []] = laneRows(lane({ description: "d".repeat(300), tool: { name: "Bash", detail: "x".repeat(300) } }), look(width), HOME);
      expect(displayWidth(text(head)), `head at ${width}`).toBe(width);
      expect(displayWidth(text(tools)), `tools at ${width}`).toBe(width);
    }
  });

  test("the call count reads as words, one call singular", () => {
    expect(text(laneRows(lane({ calls: 1 }), look(73), HOME)[1] ?? []).trimStart()).toEndWith(" 1 call");
    expect(text(laneRows(lane({ calls: 30 }), look(73), HOME)[1] ?? [])).toEndWith(" 30 calls");
  });

  test("the current tool's detail is masked and the home path shortened", () => {
    const tool = { name: "Bash", detail: "curl -H 'Authorization: Bearer abcdefghijklmnop' /home/u/x" };
    expect(text(laneRows(lane({ tool }), look(120), HOME)[1] ?? []).trimEnd()).toBe(
      `  ✳ Bash curl -H 'Authorization: Bearer ‹masked›' ~/x${" ".repeat(60)}4 calls`,
    );
  });

  test("before its first call a lane is starting, between calls thinking", () => {
    expect(text(laneRows(lane({ calls: 0, tool: null }), look(73), HOME)[1] ?? [])).toBe("  ✳ starting");
    expect(text(laneRows(lane({ tool: null }), look(73), HOME)[1] ?? [])).toBe(`  ✳ thinking${" ".repeat(54)}4 calls`);
  });

  test("no effort column without an effort, and a number effort as its number", () => {
    const none = lane({ effort: null });
    expect(rows(laneRows(none, look(73, {}, [none]), HOME))[0]).toBe("◆ executor · Fix the heading parser                    sonnet-5-5   1m06s");
    const number = lane({ effort: 32_000 });
    expect(rows(laneRows(number, look(73, {}, [number]), HOME))[0]).toContain("  32000  ");
  });

  test("an agent outside the roster draws in the muted key, and ASCII mode uses ASCII glyphs", () => {
    const general = lane({ type: "general-purpose" });
    const [head = [], tools = []] = laneRows(general, look(73, { g: A, ascii: true }, [general]), HOME);
    expect(head[0]).toEqual({ text: "@ ", color: "inactive" });
    expect(text(head)).toBe("@ general-purpose - Fix the heading parser       sonnet-5-5  high   1m06s");
    expect(text(tools)).toBe(`  - Bash bun test src/parser.spec.ts${" ".repeat(30)}4 calls`);
  });

  test("the Nerd set draws each roster agent's own icon", () => {
    const [head = []] = laneRows(lane({ type: "oh-my-claudeagent:architect" }), look(73, { g: glyphs("nerd") }), HOME);
    expect(head[0]).toEqual({ text: "\u{f0eb} ", color: "purple_FOR_SUBAGENTS_ONLY" });
  });
});

describe("laneBlock", () => {
  test("an ended agent's block says what it said and how long it ran, where a running one shows its tool", () => {
    const ended = lane({ endedAt: START + 66_000, status: "answer", result: "Fixed the parser." });
    const block = rows(laneBlock(ended, look(39), HOME));
    expect(block[0]).toBe("executor                 ✓ done   1m06s");
    expect(block[2]).toBe("Fixed the parser.");
    expect(rows(laneBlock(lane({ endedAt: START + 5_000, status: "error", result: "" }), look(39), HOME))[2]).toBe("failed");
  });

  test("an empty task keeps its row, so the block stays four rows tall", () => {
    const block = rows(laneBlock(lane({ description: "" }), look(39), HOME));
    expect(block).toHaveLength(4);
    expect(block[1]).toBe(" ");
  });
});

describe("finishedRow", () => {
  const done = (fields: Partial<Lane>) => lane({ endedAt: START + 66_000, status: "answer", result: "Fixed the parser.", ...fields });

  test("one dim line: status glyph in its tone, the type, the result, and how long it ran", () => {
    expect(finishedRow(done({}), look(51), HOME)).toEqual([
      { text: "✓ ", color: "success" },
      { text: "executor · Fixed the parser.             ", color: "inactive" },
      { text: "   1m06s", color: "inactive" },
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
    expect(row).toBe(`✓ executor · ${"r".repeat(29)}…   1m06s`);
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

describe("summaryText", () => {
  const lanes = [lane(), lane({ id: "a-2" }), lane({ id: "a-3", endedAt: START + 1000, status: "answer" })];

  test("counts running and finished agents and sums their tokens, dropping the last parts that do not fit", () => {
    expect(summaryText(lanes, G, 51)).toBe("2 running · 1 finished · 13.5k tokens");
    expect(summaryText(lanes, G, 30)).toBe("2 running · 1 finished");
    expect(summaryText(lanes, G, 12)).toBe("2 running");
    expect(summaryText(lanes, G, 5)).toBe("2 ru…");
    expect(summaryText(lanes, A, 51)).toBe("2 running - 1 finished - 13.5k tokens");
  });
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

describe("costText", () => {
  test("shows the cost to the cent after the dot, `<$0.01` for a trace, and nothing once a model was unpriced", () => {
    expect(costText(lane({ costUsd: 0.0432 }), G.dot)).toBe(" · ~$0.04");
    expect(costText(lane({ costUsd: 0.002 }), G.dot)).toBe(" · ~<$0.01");
    expect(costText(lane({ costUsd: null }), G.dot)).toBe("");
  });
});
