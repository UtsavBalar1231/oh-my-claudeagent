import type { On, RenderSurface } from "claude-code";
import { expect, test } from "claude-code/testing";
import { sizeOf } from "../../hooks/ui.ts";
import { BOULDER, LEDGER, pane, ROOT, rows, run, SESSION, spreadRows, world } from "./world.ts";

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

test("on desktop the task page names the tasks a blocked task waits on beside its BLOCKED chip, and an open task has none", async ($, on) => {
  planWorld(on);
  await $.command.run(run("plan", 56));
  const ui = await $.ui.mount(docked("desktop", 56));

  await ui.press({ key: "task-5" });
  expect(spreadRows(await ui.drawn())).toContain(" BLOCKED  by 3, 4");
  await ui.press({ key: "b" });
  await ui.press({ key: "task-3" });
  expect(spreadRows(await ui.drawn())).toContain(" BLOCKED  by 2");
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

test("on desktop a board too large for Desktop to draw shows a notice under the tab bar, where Desktop would refuse the whole tree", async ($, on) => {
  const titles = Array.from({ length: 400 }, (_, index) => `Step ${index + 1}`);
  const huge = ["# Ship the huge plan", "", "## TODOs", ...titles.map((title, index) => `- [ ] ${index + 1}. ${title}`), ""].join("\n");
  const w = world(on, {
    [PLAN_PATH]: huge,
    [BOULDER]: JSON.stringify({ plans: { long: { active_plan: PLAN_PATH } }, bindings: { [SESSION]: { plan_name: "long" } } }),
    [LEDGER]: JSON.stringify({ entries: [] }),
  });
  w.surfaces = ["desktop"];
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
