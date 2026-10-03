import { type Engine, expect, type Mounted as MountedPane, test } from "claude-code/testing";
import { sha256Hex } from "../../src/core/evidence.ts";
import { displayWidth, padEnd, usableColumns } from "../../src/core/ui-kit.ts";
import {
  BOULDER,
  bodyColumns,
  cellsAcross,
  childrenOf,
  isAscii,
  isNode,
  LEDGER,
  type Node,
  nodeByKey,
  pane,
  resettableState,
  ROOT,
  run,
  SESSION,
  SIZES,
  type Size,
  topRows,
  world,
  write,
} from "./world.ts";

const SURFACES = ["terminal", "desktop"] as const;

const PLAN_PATH = `${ROOT}/plans/sample.md`;
const PLAN_TEXT = "# Sample plan\n\n## TODOs\n\n- [x] 1. Wire the ledger\n";
const BOUND = JSON.stringify({
  plans: { sample: { active_plan: PLAN_PATH, started_at: "2026-10-01T08:00:00Z" } },
  bindings: { [SESSION]: { plan_name: "sample" } },
});
const TOKEN = `ghp_${"a1B2c3D4".repeat(5)}`;
const BEARER = `Bearer ${"x9".repeat(10)}`;
const FAILING_OUTPUT = ["(fail) the ledger draws", "  expected 3", "  received 4", "at ledger.test.ts:40", "1 fail", "41 pass", "Ran 42 tests", "exit 1", "done", "end"].join("\n");

const local = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute, 0).toISOString();

const evidence = (type: string, command: string, exit: number, timestamp: string, by: string, snippet: string, planSha?: string) => ({
  type,
  command,
  exit_code: exit,
  output_snippet: snippet,
  timestamp,
  verified_by: by,
  ...(planSha === undefined ? {} : { plan_sha256: planSha }),
});

const runs = (planSha: string) => [
  evidence("build", "bun run build", 0, local(1, 9, 0), "oh-my-claudeagent:executor", "built in 1.2 s"),
  evidence("lint", "just lint", 1, local(1, 9, 30), "oh-my-claudeagent:explore", "src/core/evidence.ts:12 unused import"),
  evidence("test", "just test-mod", 1, local(2, 10, 0), "oh-my-claudeagent:executor", FAILING_OUTPUT),
  evidence("test", `curl -H 'Authorization: ${BEARER}' https://ci.example/run && just test`, 0, local(2, 10, 20), "oh-my-claudeagent:executor", `pushed with token=${TOKEN}\n42 pass`),
  evidence("manual", "bun scripts/qa/visual.ts evidence", 0, local(2, 11, 0), "sisyphus", ""),
  evidence("final_verification", "just ci", 0, local(2, 11, 45), "sisyphus", "COMPLETE", planSha),
];

async function proofFiles(planSha?: string): Promise<Record<string, string>> {
  const sha = planSha ?? sha256Hex(PLAN_TEXT);
  return { [PLAN_PATH]: PLAN_TEXT, [BOULDER]: BOUND, [LEDGER]: JSON.stringify({ entries: runs(sha) }) };
}

// The drawing as text, one entry per terminal row: a bordered Box is framed, a Code block's
// lines are marked `│`, an Input is bracketed, and a row Box lays its children side by side.
function lines(element: unknown): string[] {
  if (typeof element === "string") return [element];
  if (!isNode(element)) return [];
  const props = element.props ?? {};
  switch (element.type) {
    case "Text":
      return [childrenOf(element).map((child) => lines(child).join("")).join("")];
    case "Button":
      return [`${String(props["hotkey"])}: ${String(props["label"])}`];
    case "Code":
      return String(props["source"]).split("\n").map((line) => `│${line}`);
    case "Input":
      return [`[${String(props["label"])}${String(props["value"]) || String(props["placeholder"])}]`];
    case "Box": {
      const children = childrenOf(element);
      if (props["flexDirection"] === "row") {
        const columns = children.map(lines);
        const widths = children.map((child, index) => {
          const fixed = isNode(child) ? child.props?.["width"] : undefined;
          return typeof fixed === "number" ? fixed : Math.max(0, ...(columns[index] ?? []).map(displayWidth));
        });
        const gap = " ".repeat(typeof props["columnGap"] === "number" ? props["columnGap"] : 0);
        const height = Math.max(1, ...columns.map((column) => column.length));
        return Array.from({ length: height }, (_, row) =>
          columns.map((column, index) => padEnd(column[row] ?? "", widths[index] ?? 0)).join(gap).trimEnd(),
        );
      }
      const pad = " ".repeat(typeof props["paddingLeft"] === "number" ? props["paddingLeft"] : 0);
      const inner = children.flatMap(lines).map((line) => `${pad}${line}`);
      return props["borderStyle"] === undefined ? inner : ["╭", ...inner.map((line) => `│ ${line}`), "╰"];
    }
    default:
      return [];
  }
}

// A row's runs as drawn: each piece's text and the colors it carries.
function runsOf(row: Node | undefined): { text: string; color?: unknown; backgroundColor?: unknown; bold?: unknown }[] {
  const line = row === undefined ? undefined : childrenOf(row)[0];
  return (isNode(line) ? childrenOf(line) : []).flatMap((piece) => {
    if (!isNode(piece)) return [];
    const { color, backgroundColor, bold } = piece.props ?? {};
    return [{ text: childrenOf(piece).join(""), ...(color === undefined ? {} : { color }), ...(backgroundColor === undefined ? {} : { backgroundColor }), ...(bold === undefined ? {} : { bold }) }];
  });
}

type Mounted = MountedPane<"terminal", "Pane">;

async function openEvidence($: Engine, size: Size): Promise<Mounted> {
  await $.command.run(run("", size.columns));
  const ui = await $.ui.mount(pane("terminal", size));
  await ui.press({ key: "3" });
  await ui.redraw();
  return ui;
}

const DOCK_120: Size = { columns: 120, rows: 40, placement: "dock" };
const INLINE_80: Size = { columns: 80, rows: 40, placement: "inline" };
const DOCK_210: Size = { columns: 210, rows: 50, placement: "dock" };
const DOCK_200: Size = { columns: 200, rows: 50, placement: "dock" };
// Tab rows and, docked, the rule under them.
const CHROME = { [DOCK_120.columns]: 3, [INLINE_80.columns]: 1, [DOCK_210.columns]: 2 } as const;
const body = async (ui: Mounted, size: Size) => lines(await ui.drawn()).slice(CHROME[size.columns] ?? 0);
const blanks = (count: number) => Array.from({ length: count }, () => " ");
const SCROLL = { component: "Pane", requestId: "omca", offset: 0, origin: { kind: "person" } } as const;

test("narrow: the verdict card, the day-grouped timeline and the focused entry opened under its row", async ($, on) => {
  world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_120);
  expect(await body(ui, DOCK_120)).toEqual([
    "╭",
    "│ Final verification · sample",
    "│  COMPLETE  matches the current plan",
    "│ 10-02 11:45",
    "│ ✓ build  ✓ test  ✗ lint  ✓ manual",
    "╰",
    "── Fri 2026-10-02 ─────────────────────────────────",
    "❯ ✓  11:45  final   just ci",
    "    │just ci",
    "    │COMPLETE",
    "    2026-10-02 11:45:00 · ◆ sisyphus",
    "  ✓  11:00  manual  bun scripts/qa/…ual.ts evidence",
    "  ✓  10:20  test    curl -H 'Author…un && just test",
    "  ✗  10:00  test    just test-mod",
    "── Thu 2026-10-01 ─────────────────────────────────",
    "  ✗  09:30  lint    just lint",
    "  ✓  09:00  build   bun run build",
    ...blanks(14),
    "t: Type  x: Fails  f: Find  c: Copy  r: Rerun",
    "1/6 · ↑↓ move",
    " ",
  ]);
  expect(nodeByKey(await ui.drawn(), "verdict")?.props).toMatchObject({ borderStyle: "round", borderColor: "success" });
  const verdict = nodeByKey(await ui.drawn(), "verdict");
  const runs = childrenOf(verdict ?? { type: "Box" }).flatMap((line) => runsOf({ type: "Box", children: [line] }));
  const latest = [" build", " test", " lint", " manual"].map((word) => runs.find((run) => run.text === word));
  expect(latest).toEqual([{ text: " build" }, { text: " test" }, { text: " lint" }, { text: " manual" }]);
  expect(runs.filter((run) => run.text === "✓" || run.text === "✗").map((run) => run.color)).toEqual(["success", "success", "error", "success"]);
  await ui.unmount();
});

test("standard: a one-line verdict above the timeline, agents named, the command shown again only when its row cut it", async ($, on) => {
  world(on, await proofFiles());
  const ui = await openEvidence($, INLINE_80);
  expect(await body(ui, INLINE_80)).toEqual([
    " COMPLETE  sample  ✓ build  ✓ test  ✗ lint  ✓ manual  10-02 11:45",
    "── Fri 2026-10-02 ───────────────────────────────────────────────────────",
    "❯ ✓  11:45  final   just ci                                    ◆ sisyphus",
    "    │COMPLETE",
    "    2026-10-02 11:45:00 · ◆ sisyphus",
    "  ✓  11:00  manual  bun scripts/qa/visual.ts evidence          ◆ sisyphus",
    "  ✓  10:20  test    curl -H 'Authorizati…ple/run && just test  ◆ executor",
    "  ✗  10:00  test    just test-mod                              ◆ executor",
    " ",
    "t: Type  x: Fails  f: Find  c: Copy  r: Rerun  1/6 · ↑↓ move",
    " ",
  ]);

  await $.ui.scroll({ ...SCROLL, by: 2, bodyRows: 10, contentRows: 11 });
  expect((await body(ui, INLINE_80)).slice(1, 10)).toEqual([
    "── Fri 2026-10-02 ───────────────────────────────────────────────────────",
    "  ✓  11:45  final   just ci                                    ◆ sisyphus",
    "  ✓  11:00  manual  bun scripts/qa/visual.ts evidence          ◆ sisyphus",
    "❯ ✓  10:20  test    curl -H 'Authorizati…ple/run && just test  ◆ executor",
    "    │curl -H 'Authorization: Bearer ‹masked›' https://ci.example/run && j…",
    "    │pushed with token=‹masked›",
    "    │42 pass",
    "    2026-10-02 10:20:00 · ◆ executor · 2 secrets masked",
    "t: Type  x: Fails  f: Find  c: Copy  r: Rerun  3/6 · ↑↓ move",
  ]);
  await ui.unmount();
});

test("wide: the list beside a card of the focused entry, which follows the focus", async ($, on) => {
  world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_210);
  const shown = await body(ui, DOCK_210);
  expect(shown.slice(0, 13)).toEqual([
    "╭",
    "│ Final verification · sample",
    "│  COMPLETE  matches the current plan · 10-02 11:45",
    "│ ✓ build  ✓ test  ✗ lint  ✓ manual",
    "╰",
    "── Fri 2026-10-02 ─────────────────────────────  ╭",
    "❯ ✓  11:45  final   just ci                      │ final · exit 0",
    "  ✓  11:00  manual  bun scripts/q…l.ts evidence  │ │just ci",
    "  ✓  10:20  test    curl -H 'Auth… && just test  │ │COMPLETE",
    "  ✗  10:00  test    just test-mod                │ 2026-10-02 11:45:00 · ◆ sisyphus",
    "── Thu 2026-10-01 ─────────────────────────────  ╰",
    "  ✗  09:30  lint    just lint",
    "  ✓  09:00  build   bun run build",
  ]);
  expect(shown.slice(-2)).toEqual(["t: Type  x: Fails  f: Find  c: Copy  r: Rerun  1/6 · ↑↓ move", " "]);

  await $.ui.scroll({ ...SCROLL, by: 3, bodyRows: 46, contentRows: 47 });
  expect((await body(ui, DOCK_210)).slice(5, 20)).toEqual([
    "── Fri 2026-10-02 ─────────────────────────────  ╭",
    "  ✓  11:45  final   just ci                      │ test · exit 1",
    "  ✓  11:00  manual  bun scripts/q…l.ts evidence  │ │just test-mod",
    "  ✓  10:20  test    curl -H 'Auth… && just test  │ │(fail) the ledger draws",
    "❯ ✗  10:00  test    just test-mod                │ │  expected 3",
    "── Thu 2026-10-01 ─────────────────────────────  │ │  received 4",
    "  ✗  09:30  lint    just lint                    │ │at ledger.test.ts:40",
    "  ✓  09:00  build   bun run build                │ │1 fail",
    "                                                 │ │41 pass",
    "                                                 │ │Ran 42 tests",
    "                                                 │ │exit 1",
    "                                                 │ │done",
    "                                                 │ │end",
    "                                                 │ 2026-10-02 10:00:00 · ◆ executor",
    "                                                 ╰",
  ]);
  expect(nodeByKey(await ui.drawn(), "detail-2")?.props).toMatchObject({ borderColor: "error", width: 41 });
  const split = nodeByKey(await ui.drawn(), "split");
  expect(childrenOf(split ?? { type: "Box" }).map((column) => (isNode(column) ? column.props : undefined))).toEqual([
    { flexDirection: "column", width: 47 },
    { flexDirection: "column" },
  ]);
  await ui.unmount();
});

test("rows lead with the outcome glyph in its tone, the type a muted word but the final verification bold, the program bold, masks dim, and the agent's glyph in its identity color", async ($, on) => {
  world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_200);
  const tree = await ui.drawn();
  expect(runsOf(nodeByKey(tree, "entry-3"))).toEqual([
    { text: "  " },
    { text: "✓", color: "success" },
    { text: "  " },
    { text: "10:20", color: "inactive" },
    { text: "  " },
    { text: "test  ", color: "inactive" },
    { text: "  " },
    { text: "curl", bold: true },
    { text: " -H 'Authorization: Be…i.example/run && just test" },
    { text: "  " },
    { text: "◆", color: "green_FOR_SUBAGENTS_ONLY" },
    { text: " executor", color: "inactive" },
  ]);
  expect(nodeByKey(tree, "entry-3")?.props).toEqual({ key: "entry-3", flexDirection: "row" });
  expect(runsOf(nodeByKey(tree, "entry-3")).filter((run) => run.backgroundColor !== undefined)).toEqual([]);
  const mark = (key: string) => runsOf(nodeByKey(tree, key))[1];
  expect(["entry-0", "entry-1", "entry-4"].map(mark)).toEqual([
    { text: "✓", color: "success" },
    { text: "✗", color: "error" },
    { text: "✓", color: "success" },
  ]);
  expect(runsOf(nodeByKey(tree, "entry-1"))[5]).toEqual({ text: "lint  ", color: "inactive" });
  expect(runsOf(nodeByKey(tree, "entry-1")).at(-1)).toEqual({ text: " explore ", color: "inactive" });
  expect(nodeByKey(tree, "entry-5")?.props).toEqual({ key: "entry-5", flexDirection: "row", backgroundColor: "selectionBg" });
  expect(runsOf(nodeByKey(tree, "entry-5"))[5]).toEqual({ text: "final ", color: "text", bold: true });
  expect(runsOf(nodeByKey(tree, "entry-5")).at(-1)).toEqual({ text: " sisyphus", color: "text", bold: true });

  await $.ui.scroll({ ...SCROLL, by: 2, bodyRows: 46, contentRows: 47 });
  const opened = await ui.drawn();
  const command = runsOf(nodeByKey(opened, "entry-3")).slice(7, 9);
  expect(command).toEqual([
    { text: "curl", color: "text", bold: true },
    { text: " -H 'Authorization: Be…i.example/run && just test", color: "text", bold: true },
  ]);
  const meta = childrenOf(nodeByKey(opened, "detail-3") ?? { type: "Box" }).at(-1);
  expect(lines(meta)).toEqual(["2026-10-02 10:20:00 · ◆ executor · 2 secrets masked"]);
  expect(isNode(meta) ? childrenOf(meta).map((piece) => (isNode(piece) ? piece.props?.["color"] : undefined)) : []).toEqual([
    "inactive",
    "inactive",
    "green_FOR_SUBAGENTS_ONLY",
    "inactive",
    "inactive",
    "inactive",
  ]);
  await ui.unmount();
});

test("a mask inside a row's command is drawn dim", async ($, on) => {
  const entries = [evidence("test", `TOKEN=${TOKEN} just test`, 0, local(2, 9, 0), "executor", "ok"), evidence("lint", "just lint", 0, local(2, 10, 0), "executor", "ok")];
  world(on, { ...(await proofFiles()), [LEDGER]: JSON.stringify({ entries }) });
  const ui = await openEvidence($, INLINE_80);
  expect(runsOf(nodeByKey(await ui.drawn(), "entry-0")).slice(7, 10)).toEqual([
    { text: "TOKEN=", bold: true },
    { text: "‹masked›", color: "inactive" },
    { text: " just test" },
  ]);
  await ui.unmount();
});

test("the verdict reads complete, stale, missing, with no plan, or with an unreadable plan", async ($, on) => {
  const w = world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_120);
  const card = async () => lines(nodeByKey(await ui.drawn(), "verdict")).slice(1, 4);
  const border = async () => nodeByKey(await ui.drawn(), "verdict")?.props?.["borderColor"];
  const refresh = () => w.clock.advance(2000);

  expect(await card()).toEqual(["│ Final verification · sample", "│  COMPLETE  matches the current plan", "│ 10-02 11:45"]);
  expect(await border()).toBe("success");

  write(w, PLAN_PATH, `${PLAN_TEXT}- [ ] 2. Added after the verification\n`);
  await refresh();
  expect(await card()).toEqual(["│ Final verification · sample", "│  STALE  plan edited since it passed", "│ 10-02 11:45"]);
  expect(await border()).toBe("warning");

  const failed = evidence("final_verification", "just ci", 1, local(2, 12, 0), "sisyphus", "INCOMPLETE", "f".repeat(64));
  write(w, LEDGER, JSON.stringify({ entries: [...runs("e".repeat(64)).filter((entry) => entry.type !== "final_verification"), failed] }));
  await refresh();
  expect(await card()).toEqual(["│ Final verification · sample", "│  MISSING  last run exited 1 · 10-02 12:00", "│ ✓ build  ✓ test  ✗ lint  ✓ manual"]);
  expect(await border()).toBe("error");

  write(w, LEDGER, JSON.stringify({ entries: runs("").slice(0, 2) }));
  await refresh();
  expect(await card()).toEqual(["│ Final verification · sample", "│  MISSING  no passing run yet", "│ ✓ build  ✗ lint"]);

  w.files.delete(PLAN_PATH);
  await refresh();
  expect(await card()).toEqual([
    "│ Final verification · sample",
    "│  UNKNOWN  Could not read the plan file: ENOENT…",
    "│ ✓ build  ✗ lint",
  ]);
  expect(await border()).toBe("warning");

  write(w, BOULDER, JSON.stringify({ plans: {}, bindings: {} }));
  await refresh();
  expect(await card()).toEqual(["│ Final verification", "│  NO PLAN  no plan is bound to this session", "│ ✓ build  ✗ lint"]);
  expect(await border()).toBe("inactive");
  await ui.unmount();
});

test("loading, an empty ledger, and an unreadable ledger each say so", async ($, on) => {
  const atoms = resettableState(on);
  const w = world(on, { [PLAN_PATH]: PLAN_TEXT, [BOULDER]: BOUND });
  const ui = await openEvidence($, DOCK_120);
  expect(await body(ui, DOCK_120)).toEqual([
    "╭",
    "│ Final verification · sample",
    "│  MISSING  no passing run yet",
    "╰",
    "No verification evidence has been logged here yet.",
  ]);

  atoms.reset("ledger");
  await ui.redraw();
  expect(await body(ui, DOCK_120)).toEqual(["Reading the evidence ledger…"]);

  write(w, LEDGER, '{"entries": [');
  await w.clock.advance(2000);
  await ui.redraw();
  const [error, ...why] = await body(ui, DOCK_120);
  expect(error).toMatch(/^✗ Could not read \.omca\/evidence\/verification-evidence\.json: \S/);
  expect((await ui.find({ type: "Text", text: /^✗ Could not read/ }))?.props).toEqual({ color: "error", wrap: "wrap" });
  expect(why).toEqual(["evidence_log refuses to write to it until it parses again, and no verdict can be read from it."]);

  write(w, LEDGER, '{"items": []}');
  await w.clock.advance(2000);
  await ui.redraw();
  expect((await body(ui, DOCK_120))[0]).toBe("✗ Could not read .omca/evidence/verification-evidence.json: it holds no entries list");
  await ui.unmount();
});

const entryRows = async (ui: Mounted) => lines(await ui.drawn()).filter((row) => /^[❯ ] [✓✗] {2}\d\d:\d\d /.test(row));
const statusRow = async (ui: Mounted) => (await body(ui, DOCK_120)).at(-2);

test("t steps through the types the ledger holds and back to all, x keeps failures, and an empty match says so", async ($, on) => {
  world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_120);
  const dim = async (key: string) => (await ui.find({ key }))?.props["dimColor"] === true;
  const types = async () => (await entryRows(ui)).map((row) => row.slice(12, 18));

  expect(await Promise.all(["t", "x", "f"].map(dim))).toEqual([true, true, true]);
  for (const key of ["b", "l", "m", "v"]) expect(await ui.find({ key })).toBeUndefined();
  await ui.press({ key: "t" });
  expect(await types()).toEqual(["build "]);
  expect(await statusRow(ui)).toBe("1/1 · build only · ↑↓ move");
  expect(await ui.find({ key: "t" })).toMatchObject({ props: { label: "Build" } });
  expect(await dim("t")).toBe(false);

  await ui.press({ key: "t" });
  expect(await types()).toEqual(["test  ", "test  "]);
  expect(await statusRow(ui)).toBe("1/2 · test only · ↑↓ move");

  await ui.press({ key: "x" });
  expect((await entryRows(ui)).map((row) => row.slice(0, 26))).toEqual(["❯ ✗  10:00  test    just t"]);
  expect(await statusRow(ui)).toBe("1/1 · test only · failures only · ↑↓ move");

  await ui.press({ key: "t" });
  expect((await entryRows(ui)).map((row) => row.slice(0, 26))).toEqual(["❯ ✗  09:30  lint    just l"]);
  expect(await statusRow(ui)).toBe("1/1 · lint only · failures only · ↑↓ move");

  await ui.press({ key: "t" });
  expect(await entryRows(ui)).toEqual([]);
  expect((await body(ui, DOCK_120)).slice(6, 7)).toEqual(["No entry matches the filter. Press t or x to change it."]);
  expect((await ui.find({ type: "Text", text: /^No entry matches/ }))?.props).toEqual({ dimColor: true, wrap: "wrap" });
  expect(await statusRow(ui)).toBe("t: Manual  x: Fails  f: Find  0/6 · nothing matches");
  expect(await ui.find({ key: "c" })).toBeUndefined();

  await ui.press({ key: "x" });
  expect(await types()).toEqual(["manual"]);
  await ui.press({ key: "t" });
  expect(await types()).toEqual(["final "]);
  await ui.press({ key: "t" });
  expect(await entryRows(ui)).toHaveLength(6);
  expect(await dim("t")).toBe(true);
  await ui.unmount();
});

test("the arrows move the focus one entry, a page key a window, Home and End to the ends, and the engine is left alone", async ($, on) => {
  const handed: number[] = [];
  on("ui.scroll", (_$, e) => (handed.push(e.by), {}));
  const entries = Array.from({ length: 600 }, (_, n) =>
    evidence(n % 7 === 0 ? "lint" : "test", `just test shard-${n}`, n % 5 === 0 ? 1 : 0, new Date(2026, 9, 2, 0, 0, n).toISOString(), "executor", `shard ${n}`),
  );
  world(on, { [PLAN_PATH]: PLAN_TEXT, [BOULDER]: BOUND, [LEDGER]: JSON.stringify({ entries }) });
  const ui = await openEvidence($, DOCK_120);
  const scroll = (by: number) => $.ui.scroll({ ...SCROLL, by, bodyRows: 36, contentRows: 37 });
  const focusedRow = async () => (await entryRows(ui)).find((row) => row.startsWith("❯"))?.slice(20).trimEnd();

  expect(await body(ui, DOCK_120)).toHaveLength(34);
  expect(await entryRows(ui)).toHaveLength(22);
  expect(await focusedRow()).toBe("just test shard-599");
  expect(await statusRow(ui)).toBe("1/600 · ↑↓ move");

  await scroll(1);
  expect(await focusedRow()).toBe("just test shard-598");
  await scroll(36);
  expect(await focusedRow()).toBe("just test shard-576");
  expect(await statusRow(ui)).toBe("24/600 · ↑↓ move");
  await scroll(-1);
  expect(await focusedRow()).toBe("just test shard-577");
  await scroll(37);
  expect(await focusedRow()).toBe("just test shard-0");
  expect(await statusRow(ui)).toBe("600/600 · ↑↓ move");
  expect((await entryRows(ui)).at(-1)).toStartWith("❯ ✗  00:00  lint    just test shard-0");
  await scroll(1);
  expect(await focusedRow()).toBe("just test shard-0");
  await scroll(-37);
  expect(await focusedRow()).toBe("just test shard-599");
  expect(handed).toEqual([]);
  await ui.unmount();
});

test("c copies the focused command as drawn, masks and all, and r fills a rerun request without sending it", async ($, on) => {
  const copies: [string, unknown][] = [];
  const fills: string[] = [];
  on("ui.copy", (_$, e) => (copies.push([e.text, e.surface]), { value: { isCopied: true } }));
  on("prompt.fill", (_$, e) => (fills.push(e.text), { isFilled: true }));
  on("prompt.submit", () => {
    throw new Error("the Evidence tab must never submit");
  });
  world(on, { ...(await proofFiles()), [LEDGER]: JSON.stringify({ entries: runs(sha256Hex(PLAN_TEXT)).map((entry, index) => (index === 3 ? { ...entry, command: `${entry.command} --home /home/u/project` } : entry)) }) });
  const ui = await openEvidence($, DOCK_120);

  await $.ui.scroll({ ...SCROLL, by: 2, bodyRows: 36, contentRows: 37 });
  await ui.press({ key: "c" });
  expect(copies).toEqual([["curl -H 'Authorization: Bearer ‹masked›' https://ci.example/run && just test --home ~/project", "terminal"]]);
  expect(await statusRow(ui)).toBe("3/6 · ↑↓ move · copied the command");

  await ui.press({ key: "r" });
  expect(fills).toEqual([
    "Run `curl -H 'Authorization: Bearer ‹masked›' https://ci.example/run && just test --home ~/project` again and log the result with evidence_log as test evidence.",
  ]);
  await $.ui.scroll({ ...SCROLL, by: -2, bodyRows: 36, contentRows: 37 });
  expect(await statusRow(ui)).toBe("1/6 · ↑↓ move");
  await ui.press({ key: "r" });
  expect(fills.at(-1)).toBe(
    `Run the final verification again (\`just ci\`) and log the verdict with evidence_log as final_verification evidence with plan_sha256="${sha256Hex(PLAN_TEXT)}".`,
  );
  await ui.unmount();
});

test("a copy the surface refuses says why", async ($, on) => {
  on("ui.copy", () => ({ value: { isCopied: false, reason: "no-clipboard" } }));
  world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_120);
  await ui.press({ key: "c" });
  expect(await statusRow(ui)).toBe("1/6 · ↑↓ move · could not copy: no-clipboard");
  await ui.unmount();
});

test("f opens the Find field and moves the focus to it; typing filters, and submitting it empty closes it", async ($, on) => {
  const w = world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_120);
  expect(await ui.find({ key: "search" })).toBeUndefined();

  await ui.press({ key: "f" });
  await w.clock.settle();
  expect((await body(ui, DOCK_120)).at(-2)).toBe("[search command, agent or type]");
  expect(w.logs.at(-1)).toBe("omca evidence could not focus search: no implementation for ui.focus");

  await ui.input({ key: "search", text: "JUST TEST", kind: "change" });
  expect((await entryRows(ui)).map((row) => row.slice(12, 18))).toEqual(["test  ", "test  "]);
  expect((await body(ui, DOCK_120)).at(-3)).toBe('1/2 · "JUST TEST" · ↑↓ move');
  expect(await ui.find({ key: "f" })).toMatchObject({ props: { label: "Find" } });
  expect((await ui.find({ key: "f" }))?.props["dimColor"]).toBeUndefined();

  await ui.input({ key: "search", text: "explore" });
  expect((await entryRows(ui)).map((row) => row.slice(12, 18))).toEqual(["lint  "]);
  await ui.input({ key: "search", text: "" });
  expect(await ui.find({ key: "search" })).toBeUndefined();
  expect(await entryRows(ui)).toHaveLength(6);
  await ui.unmount();
});

test("OMCA_GLYPHS=ascii draws the Evidence tab from the ASCII set", async ($, on) => {
  world(on, await proofFiles(), {}, { OMCA_GLYPHS: "ascii" });
  const ui = await openEvidence($, INLINE_80);
  expect(await body(ui, INLINE_80)).toEqual([
    "[COMPLETE] sample  + build  + test  x lint  + manual  10-02 11:45",
    "-- Fri 2026-10-02 -------------------------------------------------------",
    "> +  11:45  final   just ci                                    @ sisyphus",
    "    │COMPLETE",
    "    2026-10-02 11:45:00 - @ sisyphus",
    "  +  11:00  manual  bun scripts/qa/visual.ts evidence          @ sisyphus",
    "  +  10:20  test    curl -H 'Authorizat...le/run && just test  @ executor",
    "  x  10:00  test    just test-mod                              @ executor",
    " ",
    "t: Type  x: Fails  f: Find  c: Copy  r: Rerun  1/6 - ^v move",
    " ",
  ]);
  expect(runsOf(nodeByKey(await ui.drawn(), "entry-3")).slice(5, 6)).toEqual([{ text: "test  ", color: "inactive" }]);
  await $.ui.scroll({ ...SCROLL, by: 2, bodyRows: 10, contentRows: 11 });
  const drawn = (await body(ui, INLINE_80)).map((row) => row.replace(/[│╭╰]/g, ""));
  expect(drawn.filter((row) => !isAscii(row))).toEqual([]);
  expect(await ui.find({ type: "Text", text: /2 secrets masked/ })).toBeDefined();
  await ui.unmount();
});

test("Evidence rows stay inside the body less the gutter at every size, docked and inline, on both surfaces", async ($, on) => {
  const long = evidence("manual", `bun scripts/qa/visual.ts ${"evidence ".repeat(30)}`, 127, local(2, 12, 0), "oh-my-claudeagent:multimodal-looker", "x".repeat(400));
  world(on, { ...(await proofFiles()), [LEDGER]: JSON.stringify({ entries: [...runs(""), long] }) });
  await $.command.run(run(""));
  for (const size of [...SIZES, DOCK_210]) {
    for (const surface of SURFACES) {
      const room = usableColumns(bodyColumns(size));
      const ui = await $.ui.mount(pane(surface, size));
      await ui.press({ key: "3" });
      for (const searching of [false, true]) {
        if (searching) await ui.press({ key: "f" });
        for (const child of topRows(await ui.drawn())) {
          expect(cellsAcross(child), `${size.columns} ${size.placement} ${surface}`).toBeLessThanOrEqual(room);
        }
      }
      await ui.unmount();
    }
  }
});

test("by default the rows and the checklist draw Nerd Font outcome glyphs and each agent's icon, a space or a gap after each", async ($, on) => {
  world(on, await proofFiles(), {}, { OMCA_GLYPHS: "" });
  const ui = await openEvidence($, INLINE_80);
  expect((await body(ui, INLINE_80)).slice(0, 3)).toEqual([
    " COMPLETE  sample  \u{f05d} build  \u{f05d} test  \u{f057} lint  \u{f05d} manual  10-02 11:45",
    "── Fri 2026-10-02 ───────────────────────────────────────────────────────",
    "❯ \u{f05d}  11:45  final   just ci                                    \u{f01e} sisyphus",
  ]);
  const drawn = (await body(ui, INLINE_80)).join("\n");
  expect([...drawn.matchAll(/[\u{e000}-\u{f8ff}](?=\S)/gu)].map((match) => match[0])).toEqual([]);
  await ui.unmount();
});
