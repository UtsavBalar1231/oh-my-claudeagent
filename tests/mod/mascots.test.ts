import type { On, RenderElement } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { FRAME_MS, framesOf, type MascotName, type MascotState, rasterCells } from "../../src/core/mascots.ts";
import { childrenOf, isNode, type Node, nodeByKey, pane, run, type Size, textOf, usage, world } from "./world.ts";

const DOCK_120: Size = { columns: 120, rows: 40, placement: "dock" };
const DOCK_200: Size = { columns: 200, rows: 50, placement: "dock" };
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

const cellsOf = (name: MascotName, state: MascotState, frame = 0): string => {
  const frames = framesOf(name, state);
  return rasterCells(frames[frame % frames.length] as never);
};

const rasterOf = (tree: RenderElement, id: string): unknown => nodeByKey(tree, `mascot-${id}`)?.props?.["cells"];

// The pane's tick starts the timer once a drawing has laid a working mascot out.
async function running($: Engine, on: On, types: readonly string[], surface: "terminal" | "desktop" = "terminal", size: Size = DOCK_120) {
  const w = world(on, {});
  w.surfaces = [surface];
  engine(on);
  await $.command.run(run(""));
  for (const [index, type] of types.entries()) await $.agent.spawn(spawnOf(index + 1, type, `Work for ${type}`));
  w.agents = listed(...types.map((_, index) => `a-${index + 1}`));
  const ui = await $.ui.mount(pane(surface, size));
  await ui.drawn();
  await w.clock.advance(1000);
  return { w, ui };
}

test("a working mascot's frames are blitted at FRAME_MS, one blit a frame for each shown mascot, wrapping at the last", async ($, on) => {
  const { w, ui } = await running($, on, ["executor", "explorer"]);
  w.blits.length = 0;

  for (let frame = 1; frame <= 13; frame++) {
    await w.clock.advance(FRAME_MS);
    expect(w.blits.slice(-2)).toEqual([
      { requestId: "omca", key: "mascot-a-1", cells: cellsOf("executor", "working", frame) },
      { requestId: "omca", key: "mascot-a-2", cells: cellsOf("explorer", "working", frame) },
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

test("the timer stops when the wave ends, and the mascots rest on their done and failed frames", async ($, on) => {
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
  expect(rasterOf(tree, "a-1")).toBe(cellsOf("executor", "done"));
  expect(rasterOf(tree, "a-2")).toBe(cellsOf("explorer", "failed"));
  await ui.unmount();
});

test("done and failed mascots draw with no timer at all", async ($, on) => {
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

  expect(rasterOf(tree, "a-1")).toBe(cellsOf("executor", "done"));
  expect(rasterOf(tree, "a-2")).toBe(cellsOf("explorer", "failed"));
  expect(w.blits).toEqual([]);
  await ui.unmount();
});

test("an idle teammate draws dozing, with no timer", async ($, on) => {
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

test("a session that shows the pane on desktop only starts no timer, and its mascot is an Svg", async ($, on) => {
  const { w, ui } = await running($, on, ["executor"], "desktop");

  await w.clock.advance(10_000);

  expect(w.blits).toEqual([]);
  expect(await ui.find({ type: "Svg" })).toBeDefined();
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

test("the stage needs the lanes' rows and ten more: a short body draws the lanes alone and blits nothing", async ($, on) => {
  const { w, ui } = await running($, on, ["executor"], "terminal", DOCK_SHORT);

  await w.clock.advance(FRAME_MS * 5);

  expect(await ui.find({ key: "agents-stage" })).toBeUndefined();
  expect(await ui.find({ type: "Raster" })).toBeUndefined();
  expect(w.blits).toEqual([]);
  await ui.unmount();
});

test("the stage draws running agents first, then the wave's finished ones, each named under its mascot, with the rest counted", async ($, on) => {
  const { ui } = await running($, on, ["explorer", "executor"], "terminal", DOCK_200);
  await finish($, "a-1");
  await ui.redraw();

  const stage = nodeByKey(await ui.drawn(), "agents-stage") as Node;
  const row = childrenOf(stage)[0] as Node;
  const figures = childrenOf(row) as Node[];
  expect(figures.map((figure) => figure.props?.["key"])).toEqual(["stage-a-2", "stage-a-1"]);
  expect(figures.map((figure) => textOf(childrenOf(figure)[1]).trim())).toEqual(["executor", "explorer"]);
  expect(figures.map((figure) => (childrenOf(figure)[1] as Node).type)).toEqual(["Text", "Text"]);
  expect(childrenOf(stage)).toHaveLength(1);

  await ui.unmount();
});

test("a wave that ended is left off the stage when the next one starts, and a stage past the width counts the rest", async ($, on) => {
  const w = world(on, {});
  engine(on);
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "explorer", "Old"));
  await finish($, "a-1");
  await w.clock.advance(500);
  for (const [index, type] of ["executor", "architect", "planner"].entries()) await $.agent.spawn(spawnOf(index + 2, type, type));
  w.agents = listed("a-2", "a-3", "a-4");
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  const stage = nodeByKey(await ui.drawn(), "agents-stage") as Node;
  const [row, more] = childrenOf(stage) as Node[];
  expect(childrenOf(row as Node).map((figure) => (figure as Node).props?.["key"])).toEqual(["stage-a-2", "stage-a-3"]);
  expect(textOf(more)).toBe("+1");
  await ui.unmount();
});

test("the agent page's header draws its agent's mascot, and the timer animates it while the agent works", async ($, on) => {
  const { w, ui } = await running($, on, ["executor"]);
  await ui.press({ key: "open-a-1" });
  await w.clock.advance(1000);
  w.blits.length = 0;

  await w.clock.advance(FRAME_MS * 4);

  const header = nodeByKey(await ui.drawn(), "page-header") as Node;
  expect(isNode(childrenOf(header)[0])).toBe(true);
  expect((childrenOf(header)[0] as Node).type).toBe("Raster");
  await ui.redraw();
  expect(w.blits.map((blit) => blit.key)).toEqual(Array(4).fill("mascot-a-1"));
  expect(rasterOf(await ui.drawn(), "a-1")).toBe(w.blits.at(-1)?.cells);
  await ui.unmount();
});
