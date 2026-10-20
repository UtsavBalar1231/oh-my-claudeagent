import type { On, RenderSurface } from "claude-code";
import { expect, test } from "claude-code/testing";
import { isDrawable, sizeOf } from "../../hooks/ui.ts";
import { BOULDER, childrenOf, focusRequests, isNode, LEDGER, pane, POSIX, ROOT, rows, run, SESSION, spreadRows, world } from "./world.ts";

const PLAN_PATH = `${ROOT}/plans/long.md`;
const COUNT = 30;
const TITLES = Array.from({ length: COUNT }, (_, index) => `Step ${index + 1}`);
const DEPENDS: Readonly<Record<number, string>> = { 3: "2", 5: "3, 4" };

const PLAN = [
  "# Ship the long plan",
  "",
  "## TODOs",
  ...TITLES.flatMap((title, index) => [
    ...(index % 10 === 0 ? [`### Milestone ${index / 10 + 1}`] : []),
    `- [ ] ${index + 1}. ${title}`,
    ...(DEPENDS[index + 1] === undefined ? [] : [`  - Depends: ${DEPENDS[index + 1]}`]),
  ]),
  "",
].join("\n");

function planWorld(on: On) {
  const w = world(on, {
    [PLAN_PATH]: PLAN,
    [BOULDER]: JSON.stringify({ plans: { long: { active_plan: PLAN_PATH } }, bindings: { [SESSION]: { plan_name: "long" } } }),
    [LEDGER]: JSON.stringify({ entries: [] }),
  });
  w.surfaces = ["desktop"];
  return w;
}

// A dock holds at most 96 columns, so the body width is set on the props the engine hands the pane.
function docked<S extends RenderSurface>(surface: S, bodyColumns: number) {
  const base = pane(surface, { columns: 200, rows: 24, placement: "dock" });
  return { ...base, props: { ...base.props, bodyColumns } };
}

// The test engine answers no plugin's `$.ui.focus`, so each request the pane sends shows as its log line.

for (const columns of [56, 90, 120]) {
  test(`on desktop a board of more tasks than the body has rows draws every task and no more cue at ${columns} columns`, async ($, on) => {
    planWorld(on);
    await $.command.run(run("plan", columns));
    const ui = await $.ui.mount(docked("desktop", columns));

    const labels = await Promise.all(TITLES.map(async (_, index) => (await ui.find({ key: `task-${index + 1}` }))?.props["label"]));
    expect(labels).toEqual(TITLES);
    expect(rows(await ui.drawn()).filter((row) => /\bmore\b/.test(row))).toEqual([]);
    await ui.unmount();
  });
}

test("on desktop the task page names the tasks a blocked task waits on beside its BLOCKED chip; an open task, or one waiting only on the task before it, has none", async ($, on) => {
  planWorld(on);
  await $.command.run(run("plan", 56));
  const ui = await $.ui.mount(docked("desktop", 56));

  await ui.press({ key: "task-5" });
  expect(spreadRows(await ui.drawn())).toContain(" BLOCKED  by 3, 4");
  await ui.press({ key: "b" });
  await ui.press({ key: "task-3" });
  expect(spreadRows(await ui.drawn())).toContain(" OPEN ");
  expect(spreadRows(await ui.drawn()).filter((row) => /BLOCKED|blocked by/.test(row))).toEqual([]);
  await ui.press({ key: "b" });
  await ui.press({ key: "task-2" });
  expect(spreadRows(await ui.drawn())).toContain(" OPEN ");
  await ui.unmount();
});

for (const surface of ["terminal", "desktop"] as const) {
  test(`a focus event on the selected task redraws nothing and one on another task selects it, on ${surface}`, async ($, on) => {
    const w = planWorld(on);
    w.surfaces = [surface];
    await $.command.run(run("plan", 90));
    const ui = await $.ui.mount(docked(surface, 90));
    const focus = (element: string) => $.ui.focus({ component: "Pane", requestId: "omca", element, origin: { kind: "person" } });
    expect((await ui.find({ key: "task-1" }))?.props["autoFocus"]).toBe(true);

    const before = w.invalidations;
    await focus("task-1");
    expect(w.invalidations).toBe(before);

    await focus("task-4");
    expect(w.invalidations).toBe(before + 1);
    expect((await ui.find({ key: "task-4" }))?.props["autoFocus"]).toBe(true);
    await ui.unmount();
  });
}

function hugeWorld(on: On, path = PLAN_PATH) {
  const titles = Array.from({ length: 400 }, (_, index) => `Step ${index + 1}`);
  const huge = ["# Ship the huge plan", "", "## TODOs", ...titles.map((title, index) => `- [ ] ${index + 1}. ${title}`), ""].join("\n");
  const w = world(on, {
    [path]: huge,
    [BOULDER]: JSON.stringify({ plans: { long: { active_plan: path } }, bindings: { [SESSION]: { plan_name: "long" } } }),
    [LEDGER]: JSON.stringify({ entries: [] }),
  });
  w.surfaces = ["desktop"];
  return w;
}

test("on desktop a board too large for Desktop to draw shows a notice under the tab bar, where Desktop would refuse the whole tree", async ($, on) => {
  const w = hugeWorld(on);
  await $.command.run(run("plan", 90));
  const ui = await $.ui.mount(docked("desktop", 90));
  const tree = await ui.drawn();

  expect(await ui.find({ key: "task-1" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: "This view is more than Claude Desktop draws at once." })).toBeDefined();
  expect((await ui.find({ key: "2" }))?.props["label"]).toBe("Plan");
  expect(sizeOf(tree).nodes).toBeLessThan(2000);
  expect(w.logs.some((line) => /^omca plan tab is too large for desktop: \d+ nodes, \d+ characters$/.test(line))).toBe(true);
  await ui.unmount();
});

for (const columns of [56, 90]) {
  test(`on desktop a board too large to draw keeps its key row under the notice, and Plans still reaches the plan picker, at ${columns} columns`, async ($, on) => {
    hugeWorld(on, `${POSIX.plans}/huge.md`);
    await $.command.run(run("plan", columns));
    const ui = await $.ui.mount(docked("desktop", columns));
    const tree = await ui.drawn();

    expect(await ui.find({ type: "Text", text: "This view is more than Claude Desktop draws at once." })).toBeDefined();
    expect(await ui.find({ key: "f" })).toBeUndefined();
    await ui.press({ key: "m" });
    expect(await ui.find({ key: "f" })).toBeDefined();
    expect(await ui.find({ key: "l" })).toBeDefined();
    expect(isDrawable(sizeOf(tree))).toBe(true);

    await ui.press({ key: "l" });
    expect(await ui.find({ key: "pick-0" })).toBeDefined();
    await ui.unmount();
  });
}

for (const columns of [56, 90]) {
  test(`on desktop f on a board too large to draw opens the Find field, which narrows it, at ${columns} columns`, async ($, on) => {
    hugeWorld(on);
    await $.command.run(run("plan", columns));
    const ui = await $.ui.mount(docked("desktop", columns));

    await ui.press({ key: "m" });
    await ui.press({ key: "f" });
    expect(await ui.find({ key: "filter" })).toBeDefined();
    expect(isDrawable(sizeOf(await ui.drawn()))).toBe(true);

    await $.ui.input({ plugin: "oh-my-claudeagent", key: "filter", text: "Step 399", kind: "change" });
    expect(await ui.find({ type: "Text", text: "This view is more than Claude Desktop draws at once." })).toBeUndefined();
    expect(await ui.find({ key: "task-399" })).toBeDefined();
    await ui.unmount();
  });
}

for (const surface of ["desktop", "terminal"] as const) {
  test(`on ${surface} the Find field ${surface === "desktop" ? "asks the text cursor to enter it" : "leaves the ring where the engine holds it"}`, async ($, on) => {
    const w = planWorld(on);
    w.surfaces = [surface];
    await $.command.run(run("plan", 90));
    const ui = await $.ui.mount(docked(surface, 90));

    await ui.press({ key: "m" });
    await ui.press({ key: "f" });
    const field = await ui.find({ key: "filter" });
    expect(field).toBeDefined();
    expect(field?.props["autoFocus"]).toBe(surface === "desktop" ? true : undefined);
    await ui.unmount();
  });
}

test("on desktop opening a task's page focuses its Board key, and Board focuses the task again, so the next hotkey reaches the pane", async ($, on) => {
  const w = planWorld(on);
  await $.command.run(run("plan", 56));
  const ui = await $.ui.mount(docked("desktop", 56));
  await w.clock.advance(1);

  await ui.press({ key: "task-5" });
  await w.clock.advance(1);
  expect(await ui.find({ key: "b" })).toBeDefined();
  expect(focusRequests(w.logs).at(-1)).toBe("b");

  await ui.press({ key: "b" });
  await w.clock.advance(1);
  expect(await ui.find({ key: "task-5" })).toBeDefined();
  expect(focusRequests(w.logs).at(-1)).toBe("task-5");
  await ui.unmount();
});

test("on desktop a section opened from the contents focuses its Contents key, and Evidence focuses its tab", async ($, on) => {
  const w = planWorld(on);
  await $.command.run(run("plan", 56));
  const ui = await $.ui.mount(docked("desktop", 56));

  await ui.press({ key: "m" });
  await ui.press({ key: "t" });
  await ui.press({ key: "row-3" });
  await w.clock.advance(1);
  expect(await ui.find({ key: "t" })).toBeDefined();
  expect(focusRequests(w.logs).at(-1)).toBe("t");

  await ui.press({ key: "t" });
  await ui.press({ key: "b" });
  await ui.press({ key: "e" });
  await w.clock.advance(1);
  expect(focusRequests(w.logs).at(-1)).toBe("3");
  await ui.unmount();
});

test("in the terminal opening a task's page leaves the ring where the engine holds it", async ($, on) => {
  const w = planWorld(on);
  w.surfaces = ["terminal"];
  await $.command.run(run("plan", 56));
  const ui = await $.ui.mount(docked("terminal", 56));

  await ui.press({ key: "task-5" });
  await w.clock.advance(1);
  expect(await ui.find({ key: "b" })).toBeDefined();
  expect(focusRequests(w.logs)).not.toContain("b");
  await ui.unmount();
});

const nodesOf = (node: unknown): Record<string, unknown>[] =>
  isNode(node) ? [{ type: node.type, ...node.props }, ...childrenOf(node).flatMap(nodesOf)] : [];

test("a desktop board sends semibold, mono spans, tabular digits and named row gaps", async ($, on) => {
  planWorld(on);
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  await $.session.start({ cwd: ROOT, surface: "desktop", isInteractive: true });
  await $.command.run(run("plan", 90));
  const ui = await $.ui.mount(docked("desktop", 90));
  const nodes = nodesOf(await ui.drawn());
  const texts = nodes.filter(({ type }) => type === "Text");

  expect(texts.some((props) => props["weight"] === "semibold")).toBe(true);
  expect(texts.some((props) => props["mono"] === true)).toBe(true);
  expect(texts.filter((props) => props["mono"] === true && "tabular" in props)).toEqual([]);
  expect(texts.some((props) => props["tabular"] === true)).toBe(true);
  expect(nodes.some((props) => props["rowGap"] === "md")).toBe(true);
  await ui.unmount();
});
