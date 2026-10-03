import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { LAYOUTS, POSIX, pane, run, SESSION, type Size, world } from "./world.ts";

const PLAN = [
  "# Ship the thing",
  "",
  "Intro line.",
  "",
  "## Why",
  "Because.",
  "",
  "## TODOs",
  "### Milestone 0",
  "- [x] 1. Do the first thing",
  "  - File: `a.ts`",
  "- [ ] 2. Do the second thing",
  "  ```",
  "  ## not a heading",
  "  - [ ] 9. not a task",
  "  ```",
  "",
].join("\n");

for (const layout of LAYOUTS) {
  const suffix = layout === POSIX ? "" : ` (${layout.name})`;
  const SHIP = `${layout.plans}/ship.md`;
  const BOUND = JSON.stringify({
    plans: { ship: { active_plan: layout === POSIX ? SHIP : SHIP.replaceAll("/", "\\") } },
    bindings: { [SESSION]: { plan_name: "ship" } },
  });

  test(`/omca plan opens the bound plan on its first open task and pages through it${suffix}`, async ($, on) => {
    const w = world(on, { [layout.boulder]: BOUND, [SHIP]: PLAN }, {}, {}, layout);

    expect(await $.command.run(run("plan"))).toEqual({});

    for (const surface of ["terminal", "desktop"] as const) {
      const ui = await $.ui.mount(pane(surface));
      expect(await ui.find({ type: "Text", text: "Ship the thing" })).toBeDefined();
      expect(await ui.find({ type: "Text", text: "1/2 tasks done · ~/.claude/plans/ship.md" })).toBeDefined();
      expect((await ui.find({ key: "row-5" }))?.props["autoFocus"]).toBe(true);
      expect(await ui.find({ key: "row-2" })).toBeUndefined();

      await ui.press({ key: "row-4" });
      expect(await ui.find({ key: "md-4-0" })).toBeDefined();
      expect((await ui.find({ key: "p" }))?.props["dimColor"]).toBeUndefined();
      await ui.press({ key: "n" });
      expect(await ui.find({ key: "md-5-0" })).toBeDefined();
      expect((await ui.find({ key: "n" }))?.props["dimColor"]).toBe(true);
      expect(await ui.find({ type: "Text", text: "4 / 4" })).toBeDefined();

      await ui.press({ key: "t" });
      await w.clock.settle();
      expect((await ui.find({ key: "row-5" }))?.props["autoFocus"]).toBe(true);
      // The test kit cannot resolve a plugin's own $.ui.focus, so the refocus shows as its refusal.
      expect(w.logs.at(-1)).toBe("omca plan could not refocus row-5: no implementation for ui.focus");
      await ui.unmount();
    }
  });

  test(`moving focus onto a row moves the pointer${suffix}`, async ($, on) => {
    world(on, { [SHIP]: PLAN }, {}, {}, layout);

    await $.command.run(run("plan ship"));
    const ui = await $.ui.mount(pane("terminal"));
    await $.ui.focus({ component: "Pane", requestId: "omca", element: "row-1", origin: { kind: "person" } });

    expect((await ui.find({ key: "row-1" }))?.props["autoFocus"]).toBe(true);
    expect((await ui.find({ key: "row-5" }))?.props["autoFocus"]).toBeUndefined();
    await ui.unmount();
  });

  test(`with no bound plan it lists recent plans, newest first${suffix}`, async ($, on) => {
    const w = world(
      on,
      {
        [`${layout.plans}/old.md`]: PLAN,
        [`${layout.plans}/notes.txt`]: "not a plan",
        [`${layout.plans}/new.md`]: PLAN,
      },
      {},
      {},
      layout,
    );
    w.files.set(`${layout.plans}/old.md`, { text: PLAN, mtimeMs: Date.UTC(2026, 0, 2) });
    w.files.set(`${layout.plans}/new.md`, { text: PLAN, mtimeMs: Date.UTC(2026, 9, 2) });

    await $.command.run(run("plan"));
    const ui = await $.ui.mount(pane("terminal"));

    expect(await ui.find({ type: "Text", text: "2 most recent in ~/.claude/plans" })).toBeDefined();
    expect((await ui.find({ key: "pick-0" }))?.props["label"]).toBe("new");
    expect((await ui.find({ key: "pick-1" }))?.props["label"]).toBe("old");
    expect(await ui.find({ key: "pick-2" })).toBeUndefined();
    await ui.unmount();
  });

  test(`the Plans list puts the cursor on the bound plan whatever its spelling${suffix}`, async ($, on) => {
    const zed = `${layout.plans}/zed.md`;
    const w = world(on, { [layout.boulder]: BOUND, [SHIP]: PLAN, [zed]: PLAN }, {}, {}, layout);
    w.files.set(SHIP, { text: PLAN, mtimeMs: Date.UTC(2026, 0, 2) });
    w.files.set(zed, { text: PLAN, mtimeMs: Date.UTC(2026, 9, 2) });

    await $.command.run(run("plan"));
    const ui = await $.ui.mount(pane("terminal"));
    await ui.press({ key: "l" });

    expect((await ui.find({ key: "pick-1" }))?.props["label"]).toBe("ship");
    expect((await ui.find({ key: "pick-1" }))?.props["autoFocus"]).toBe(true);
    expect((await ui.find({ key: "pick-0" }))?.props["autoFocus"]).toBeUndefined();
    await ui.unmount();
  });

  test(`an unreadable plan shows the reason instead of failing${suffix}`, async ($, on) => {
    world(on, {}, {}, {}, layout);

    await $.command.run(run("plan missing"));
    const ui = await $.ui.mount(pane("terminal"));

    expect(await ui.find({ type: "Text", text: "✗ Could not read ~/.claude/plans/missing.md" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: `ENOENT: no such file, ${layout.plans}/missing.md` })).toBeDefined();
    expect(await ui.find({ key: "l" })).toBeDefined();
    await ui.unmount();
  });
}

const SCROLL = { component: "Pane", requestId: "omca", offset: 0, origin: { kind: "person" } } as const;
const LONG = ["# Long", "", "## TODOs", ...Array.from({ length: 30 }, (_, i) => `- [ ] ${i + 1}. Task ${i + 1}`), ""].join("\n");

const FILES = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`${POSIX.plans}/plan-${i}.md`, LONG]));

const DOCK: Size = { columns: 120, rows: 20, placement: "dock" };

async function windowed($: Engine, on: On, files: Record<string, string>, args: string, size: Size = DOCK) {
  world(on, files);
  const engine: number[] = [];
  on("ui.scroll", (_$, e) => (engine.push(e.by), {}));
  await $.command.run(run(args));
  const ui = await $.ui.mount(pane("terminal", size));
  const current = async () => (await ui.findAll({ type: "Button" })).filter((b) => b.props["autoFocus"] === true).map((b) => b.key);
  const key = async (by: number, contentRows = 15, bodyRows = 16) => {
    await $.ui.scroll({ ...SCROLL, by, bodyRows, contentRows });
    return current();
  };
  return { ui, engine, current, key };
}

test("on the Contents list a page key moves the pointer by the rows the window shows, Home and End go to the ends, and the wheel is left to the engine", async ($, on) => {
  const { ui, engine, current, key } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long");
  expect(await current()).toEqual(["row-1"]);

  expect(await key(16)).toEqual(["row-4"]);
  expect(await key(16)).toEqual(["row-8"]);
  expect(await key(-16)).toEqual(["row-4"]);
  expect(await key(15)).toEqual(["row-30"]);
  expect(await key(16)).toEqual(["row-30"]);
  expect(await key(-15)).toEqual(["row-1"]);
  expect(await key(-16)).toEqual(["row-1"]);
  expect(engine).toEqual([]);

  expect(await key(1)).toEqual(["row-1"]);
  expect(await key(-3)).toEqual(["row-1"]);
  expect(engine).toEqual([1, -3]);
  await ui.unmount();
});

test("where the body and the tree are the same height a page key pages and does not jump to the end", async ($, on) => {
  const { ui, current, key } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long", { columns: 80, rows: 40, placement: "inline" });
  expect(await current()).toEqual(["row-1"]);
  expect(await key(12, 12, 12)).toEqual(["row-6"]);
  expect(await key(-12, 12, 12)).toEqual(["row-1"]);
  await ui.unmount();
});

test("on the Plans list a page key and Home and End move the pointer over the plans", async ($, on) => {
  const { ui, current, key } = await windowed($, on, FILES, "plan");
  expect(await current()).toEqual(["pick-0"]);

  expect(await key(15)).toEqual(["pick-5"]);
  expect(await key(-15)).toEqual(["pick-0"]);
  expect(await key(16)).toEqual(["pick-4"]);
  expect(await key(-16)).toEqual(["pick-0"]);
  await ui.unmount();
});

test("on a section's page the scroll keys reach the engine, which scrolls the page", async ($, on) => {
  const { ui, engine, key } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long");
  await ui.press({ key: "row-1" });

  for (const by of [16, 31, -31, -16, 1]) await key(by, 31);
  expect(engine).toEqual([16, 31, -31, -16, 1]);
  await ui.unmount();
});

test("every Plan view names Esc as the way out, and a section's page names it beside the scroll keys", async ($, on) => {
  const { ui } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long");
  expect(await ui.find({ type: "Text", text: "↑↓ move · enter open · esc close" })).toBeDefined();

  await ui.press({ key: "l" });
  expect(await ui.find({ type: "Text", text: "↑↓ move · enter open · esc close" })).toBeDefined();

  await ui.press({ key: "pick-0" });
  await ui.press({ key: "row-1" });
  expect(await ui.find({ type: "Text", text: "↑↓ scroll · esc close" })).toBeDefined();
  await ui.unmount();
});
