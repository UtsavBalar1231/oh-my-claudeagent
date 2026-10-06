import type { On, RenderElement } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { FRAME_MS, framesOf, type MascotName, type MascotSize, type MascotState, rasterCells, svgOf } from "../../src/core/mascots.ts";
import { childrenOf, isNode, type Node, nodeByKey, pane, run, type Size, usage, world } from "./world.ts";

const DOCK_120: Size = { columns: 120, rows: 40, placement: "dock" };
const DOCK_SHORT: Size = { columns: 120, rows: 14, placement: "dock" };

const spawnOf = (n: number, type: string, description: string) =>
  ({
    tool_use_id: `toolu_${n}`,
    prompt: description,
    description,
    subagentType: `oh-my-claudeagent:${type}`,
    provider: { plugin: "oh-my-claudeagent", tier: "user" },
    parentModel: "claude-opus-5-5",
    background: true,
    fork: false,
  }) as const;

function engine(on: On): void {
  let spawned = 0;
  on("agent.spawn", () => ({ model: "claude-sonnet-5-5", agentId: `a-${++spawned}` }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
}

const finish = ($: Engine, agentId: string, reason: "answer" | "error" = "answer") =>
  $.turn.complete({ answer: "Done.", durationMs: 1000, isAborted: false, turnId: `t-${agentId}`, reason, agentId, usage: usage(2000, 500) });

const listed = (...ids: string[]) => ids.map((id) => ({ id, description: "", type: "x", status: "running" as const }));

// The Agents tab draws minis in its lanes; the agent page draws the full-size mascot.
const cellsOf = (name: MascotName, state: MascotState, frame = 0, size: MascotSize = "mini"): string => {
  const frames = framesOf(name, state, size);
  return rasterCells(frames[frame % frames.length] as never);
};

const rasterOf = (tree: RenderElement, id: string): unknown => nodeByKey(tree, `mascot-${id}`)?.props?.["cells"];

// The pane's reading tick, every 2 s, starts the timer once a drawing has laid a working mascot out.
async function running($: Engine, on: On, types: readonly string[], surface: "terminal" | "desktop" = "terminal", size: Size = DOCK_120, settings: Record<string, unknown> = {}) {
  const w = world(on, {}, settings);
  w.surfaces = [surface];
  engine(on);
  await $.command.run(run(""));
  for (const [index, type] of types.entries()) await $.agent.spawn(spawnOf(index + 1, type, `Work for ${type}`));
  w.agents = listed(...types.map((_, index) => `a-${index + 1}`));
  const ui = await $.ui.mount(pane(surface, size));
  await ui.drawn();
  await w.clock.advance(2000);
  return { w, ui };
}

test("each running lane leads with its mini, a 15 by 4 Raster beside its rows, in spawn order", async ($, on) => {
  const { ui } = await running($, on, ["explorer", "executor"]);

  const tree = await ui.drawn();
  const lane = (id: string) => nodeByKey(tree, `agent-${id}`) as Node;
  const [row] = childrenOf(lane("a-1")) as Node[];
  const [gutter, column] = row === undefined ? [] : (childrenOf(row) as Node[]);
  const mini = gutter === undefined ? undefined : (childrenOf(gutter)[0] as Node);
  expect([mini?.type, mini?.props?.["columns"], mini?.props?.["rows"], mini?.props?.["key"]]).toEqual(["Raster", 15, 4, "mascot-a-1"]);
  expect(column === undefined ? 0 : childrenOf(column).length).toBe(4);
  expect([rasterOf(tree, "a-1"), rasterOf(tree, "a-2")]).toEqual([cellsOf("explorer", "working"), cellsOf("executor", "working")]);
  await ui.unmount();
});

test("a working mini's frames are blitted at FRAME_MS at 15 by 4, one blit a frame for each lane, wrapping at the last", async ($, on) => {
  const { w, ui } = await running($, on, ["executor", "explorer"]);
  w.blits.length = 0;

  for (let frame = 1; frame <= 13; frame++) {
    await w.clock.advance(FRAME_MS);
    expect(w.blits.slice(-2)).toEqual([
      { requestId: "omca", key: "mascot-a-1", cells: cellsOf("executor", "working", frame), columns: 15, rows: 4 },
      { requestId: "omca", key: "mascot-a-2", cells: cellsOf("explorer", "working", frame), columns: 15, rows: 4 },
    ]);
  }
  expect(w.blits).toHaveLength(26);
  await ui.unmount();
});

test("a redraw in the middle of the loop draws the frame the blits are at, not frame 0", async ($, on) => {
  const { w, ui } = await running($, on, ["executor"]);

  await w.clock.advance(FRAME_MS * 5);
  await ui.redraw();

  expect(rasterOf(await ui.drawn(), "a-1")).toBe(cellsOf("executor", "working", 5));
  await ui.unmount();
});

test("the timer stops when the wave ends, and the wave's minis rest on their done and failed frames", async ($, on) => {
  const { w, ui } = await running($, on, ["executor", "explorer"]);
  await w.clock.advance(FRAME_MS * 2);

  await finish($, "a-1");
  await finish($, "a-2", "error");
  await w.clock.advance(FRAME_MS * 2);
  const after = w.blits.length;
  await w.clock.advance(10_000);
  await ui.redraw();

  expect(w.blits).toHaveLength(after);
  const tree = await ui.drawn();
  expect([rasterOf(tree, "a-1"), rasterOf(tree, "a-2")]).toEqual([cellsOf("executor", "done"), cellsOf("explorer", "failed")]);
  await ui.unmount();
});

test("when the last working mini stops, the timer redraws the pane once so the still frame is the last one", async ($, on) => {
  const { w, ui } = await running($, on, ["executor"]);
  await w.clock.advance(FRAME_MS * 2);

  await finish($, "a-1");
  const before = w.invalidations;
  await w.clock.advance(FRAME_MS);

  expect(w.invalidations).toBe(before + 1);
  await ui.unmount();
});

test("the latest wave's finished agents keep still done and failed minis, with no timer", async ($, on) => {
  const w = world(on, {});
  engine(on);
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "executor", "One"));
  await $.agent.spawn(spawnOf(2, "explorer", "Two"));
  await finish($, "a-1");
  await finish($, "a-2", "error");
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  const tree = await ui.drawn();
  await w.clock.advance(10_000);

  expect([rasterOf(tree, "a-1"), rasterOf(tree, "a-2")]).toEqual([cellsOf("executor", "done"), cellsOf("explorer", "failed")]);
  expect(w.blits).toEqual([]);
  await ui.unmount();
});

test("a new wave sends the last wave's finished agents to one-line rows without their minis", async ($, on) => {
  const w = world(on, {});
  engine(on);
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "explorer", "Earlier"));
  await finish($, "a-1");
  await w.clock.advance(5_000);
  await $.agent.spawn(spawnOf(2, "executor", "Now"));
  w.agents = listed("a-2");
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  const tree = await ui.drawn();
  expect(rasterOf(tree, "a-1")).toBeUndefined();
  expect(rasterOf(tree, "a-2")).toBe(cellsOf("executor", "working"));
  await ui.unmount();
});

test("an idle teammate's lane draws its mini dozing, with no timer", async ($, on) => {
  const w = world(on, {});
  engine(on);
  await $.command.run(run(""));
  await $.agent.spawn({ ...spawnOf(1, "executor", "Teammate work"), isTeammate: true });
  await finish($, "a-1");
  w.agents = [{ id: "a-1", description: "", type: "x", status: "idle" }];
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  await w.clock.advance(10_000);
  await ui.redraw();

  expect(rasterOf(await ui.drawn(), "a-1")).toBe(cellsOf("executor", "idle"));
  expect(w.blits).toEqual([]);
  await ui.unmount();
});

test("a session that shows the pane on desktop only starts no timer, and its mini is a 60 by 32 pixel Svg", async ($, on) => {
  const { w, ui } = await running($, on, ["executor"], "desktop");

  await w.clock.advance(10_000);

  expect(w.blits).toEqual([]);
  const svg = await ui.find({ type: "Svg" });
  expect([svg?.props["width"], svg?.props["height"]]).toEqual([60, 32]);
  expect(await ui.find({ type: "Raster" })).toBeUndefined();
  await ui.unmount();
});

test("the timer stops when the surfaces lose the terminal", async ($, on) => {
  const { w, ui } = await running($, on, ["executor"]);
  await w.clock.advance(FRAME_MS * 2);
  const before = w.blits.length;
  expect(before).toBeGreaterThan(0);

  w.surfaces = ["desktop"];
  await w.clock.advance(FRAME_MS * 2);
  const after = w.blits.length;
  await w.clock.advance(10_000);

  expect(w.blits).toHaveLength(after);
  await ui.unmount();
});

test("a body too short for every relaxed lane draws the compact lanes, with no mascot and no blits", async ($, on) => {
  const { w, ui } = await running($, on, ["executor", "explorer", "architect"], "terminal", DOCK_SHORT);

  await w.clock.advance(FRAME_MS * 5);

  expect(await ui.find({ type: "Raster" })).toBeUndefined();
  expect(await ui.find({ key: "lane-a-1" })).toBeDefined();
  expect(w.blits).toEqual([]);
  await ui.unmount();
});

test("the agent page's header draws its agent's full-size mascot, and the timer animates it while the agent works", async ($, on) => {
  const { w, ui } = await running($, on, ["executor"]);
  await ui.press({ key: "open-a-1" });
  await w.clock.advance(1000);
  w.blits.length = 0;

  await w.clock.advance(FRAME_MS * 4);

  const header = nodeByKey(await ui.drawn(), "page-header") as Node;
  expect(isNode(childrenOf(header)[0])).toBe(true);
  expect([(childrenOf(header)[0] as Node).type, (childrenOf(header)[0] as Node).props?.["columns"]]).toEqual(["Raster", 16]);
  await ui.redraw();
  expect(w.blits.map((blit) => [blit.key, blit.columns, blit.rows])).toEqual(Array(4).fill(["mascot-a-1", 16, 8]));
  expect(rasterOf(await ui.drawn(), "a-1")).toBe(w.blits.at(-1)?.cells);
  await ui.unmount();
});

test("a body too short for the mascot and the page below it draws the page header without one", async ($, on) => {
  const { w, ui } = await running($, on, ["executor"], "terminal", DOCK_SHORT);
  await ui.press({ key: "open-a-1" });
  await w.clock.advance(FRAME_MS * 3);

  expect(await ui.find({ key: "page-header" })).toBeUndefined();
  expect(await ui.find({ type: "Raster" })).toBeUndefined();
  expect(w.blits).toEqual([]);
  await ui.unmount();
});

test("leaving the Agents tab stops the blits, and coming back starts them again", async ($, on) => {
  const { w, ui } = await running($, on, ["executor"]);
  await w.clock.advance(FRAME_MS * 2);
  expect(w.blits.length).toBeGreaterThan(0);

  await ui.press({ key: "2" });
  await w.clock.advance(FRAME_MS * 2);
  const away = w.blits.length;
  await w.clock.advance(5000);
  expect(w.blits).toHaveLength(away);

  await ui.press({ key: "1" });
  await ui.drawn();
  await w.clock.advance(2000 + FRAME_MS * 2);
  expect(w.blits.length).toBeGreaterThan(away);
  await ui.unmount();
});

test("with prefersReducedMotion on, a working mini starts no timer, blits nothing and draws frame 0", async ($, on) => {
  const { w, ui } = await running($, on, ["executor"], "terminal", DOCK_120, { prefersReducedMotion: true });

  await w.clock.advance(FRAME_MS * 10);
  await ui.redraw();

  expect(w.blits).toEqual([]);
  expect(rasterOf(await ui.drawn(), "a-1")).toBe(cellsOf("executor", "working", 0));
  await ui.unmount();
});

test("with prefersReducedMotion on, a working mini is a still Svg that is not interactive", async ($, on) => {
  const { ui } = await running($, on, ["executor"], "desktop", DOCK_120, { prefersReducedMotion: true });

  const svg = await ui.find({ type: "Svg" });
  expect(svg?.props["isInteractive"]).toBeUndefined();
  expect(svg?.props["source"]).toBe(svgOf(framesOf("executor", "working", "mini"), FRAME_MS, true));
  await ui.unmount();
});

test("with prefersReducedMotion false or absent, the timer runs", async ($, on) => {
  const { w, ui } = await running($, on, ["executor"], "terminal", DOCK_120, { prefersReducedMotion: false });
  await w.clock.advance(FRAME_MS * 3);
  expect(w.blits.length).toBeGreaterThan(0);
  await ui.unmount();
});
