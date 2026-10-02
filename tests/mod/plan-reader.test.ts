import { expect, test } from "claude-code/testing";
import { type Keyboard, regainKeyboard } from "../../hooks/tabs/plan.ts";
import { BOULDER, HOME, PLANS, pane, run, SESSION, world } from "./world.ts";

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

const SHIP = `${HOME}/.claude/plans/ship.md`;
const BOUND = JSON.stringify({
  plans: { ship: { active_plan: SHIP } },
  bindings: { [SESSION]: { plan_name: "ship" } },
});

test("/omca plan opens the bound plan on its first open task and pages through it", async ($, on) => {
  const w = world(on, { [BOULDER]: BOUND, [SHIP]: PLAN });

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

test("moving focus onto a row moves the pointer", async ($, on) => {
  world(on, { [SHIP]: PLAN });

  await $.command.run(run("plan ship"));
  const ui = await $.ui.mount(pane("terminal"));
  await $.ui.focus({ component: "Pane", requestId: "omca", element: "row-1", origin: { kind: "person" } });

  expect((await ui.find({ key: "row-1" }))?.props["autoFocus"]).toBe(true);
  expect((await ui.find({ key: "row-5" }))?.props["autoFocus"]).toBeUndefined();
  await ui.unmount();
});

test("with no bound plan it lists recent plans, newest first", async ($, on) => {
  const w = world(on, {
    [`${PLANS}/old.md`]: PLAN,
    [`${PLANS}/notes.txt`]: "not a plan",
    [`${PLANS}/new.md`]: PLAN,
  });
  w.files.set(`${PLANS}/old.md`, { text: PLAN, mtimeMs: Date.UTC(2026, 0, 2) });
  w.files.set(`${PLANS}/new.md`, { text: PLAN, mtimeMs: Date.UTC(2026, 9, 2) });

  await $.command.run(run("plan"));
  const ui = await $.ui.mount(pane("terminal"));

  expect(await ui.find({ type: "Text", text: "2 most recent in ~/.claude/plans" })).toBeDefined();
  expect((await ui.find({ key: "pick-0" }))?.props["label"]).toBe("new");
  expect((await ui.find({ key: "pick-1" }))?.props["label"]).toBe("old");
  expect(await ui.find({ key: "pick-2" })).toBeUndefined();
  await ui.unmount();
});

test("an unreadable plan shows the reason instead of failing", async ($, on) => {
  world(on);

  await $.command.run(run("plan missing"));
  const ui = await $.ui.mount(pane("terminal"));

  expect(await ui.find({ type: "Text", text: "✗ Could not read ~/.claude/plans/missing.md" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: "ENOENT: no such file, /home/u/.claude/plans/missing.md" })).toBeDefined();
  expect(await ui.find({ key: "l" })).toBeDefined();
  await ui.unmount();
});

// A test cannot raise the person's Esc, so the schedule runs against a keyboard of its own.
async function keyboardHeldAfter(failures: number) {
  const seen = { waits: [] as number[], regains: 0, refocused: 0, logs: [] as string[] };
  const queue: (() => Promise<void>)[] = [];
  const keyboard: Keyboard = {
    regain: async () => void (seen.regains += 1),
    isHeld: async () => seen.regains > failures,
    after: (ms, run) => void (seen.waits.push(ms), queue.push(run)),
    log: (text) => void seen.logs.push(text),
  };
  regainKeyboard(keyboard, async () => void (seen.refocused += 1));
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) await next();
  return seen;
}

test("after Esc the pane asks for the keyboard back at growing delays and stops once it holds it", async () => {
  expect(await keyboardHeldAfter(2)).toEqual({ waits: [0, 50, 150], regains: 3, refocused: 1, logs: [] });
  expect(await keyboardHeldAfter(0)).toEqual({ waits: [0], regains: 1, refocused: 1, logs: [] });
});

test("a keyboard that never comes back is asked for four times and logged once", async () => {
  expect(await keyboardHeldAfter(9)).toEqual({
    waits: [0, 50, 150, 400],
    regains: 4,
    refocused: 0,
    logs: ["omca plan could not take the keyboard back after 4 attempts"],
  });
});
