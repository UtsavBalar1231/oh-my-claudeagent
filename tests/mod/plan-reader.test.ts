import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import {
  BOULDER,
  childrenOf,
  hold,
  isNode,
  LAYOUTS,
  LEDGER,
  POSIX,
  pane,
  ROOT,
  rows,
  run,
  SESSION,
  type Size,
  spreadRows,
  textOf,
  topRows,
  world,
  write,
} from "./world.ts";

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

  test(`/omca plan opens the bound plan's board on its first open task, and t reads its sections${suffix}`, async ($, on) => {
    const w = world(on, { [layout.boulder]: BOUND, [SHIP]: PLAN }, {}, {}, layout);

    expect(await $.command.run(run("plan"))).toEqual({});

    for (const surface of ["terminal", "desktop"] as const) {
      const ui = await $.ui.mount(pane(surface));
      expect((await ui.find({ key: "task-2" }))?.props["autoFocus"]).toBe(true);
      expect(await ui.find({ key: "task-9" })).toBeUndefined();

      await ui.press({ key: "t" });
      expect(await ui.find({ type: "Text", text: "Ship the thing" })).toBeDefined();
      expect(await ui.find({ type: "Text", text: "1/2 tasks done · ~/.claude/plans/ship.md" })).toBeDefined();
      expect((await ui.find({ key: "row-5" }))?.props["autoFocus"]).toBe(true);
      expect(await ui.find({ key: "row-2" })).toBeUndefined();

      await ui.press({ key: "row-4" });
      expect(await ui.find({ type: "Text", text: "[x] 1. Do the first thing" })).toBeDefined();
      expect((await ui.find({ key: "p" }))?.props["dimColor"]).toBeUndefined();
      await ui.press({ key: "n" });
      expect((await ui.find({ type: "Code", text: "## not a heading" }))?.props["source"]).toBe("## not a heading");
      expect((await ui.find({ key: "n" }))?.props["dimColor"]).toBe(true);
      expect(await ui.find({ type: "Text", text: "4 / 4" })).toBeDefined();

      await ui.press({ key: "t" });
      await w.clock.settle();
      expect((await ui.find({ key: "row-5" }))?.props["autoFocus"]).toBe(true);
      // The test kit cannot resolve a plugin's own $.ui.focus, so the refocus shows as its refusal.
      expect(w.logs.at(-1)).toBe("omca plan could not focus row-5: no implementation for ui.focus");
      await ui.press({ key: "b" });
      await ui.unmount();
    }
  });

  test(`moving focus onto a row moves the cursor${suffix}`, async ($, on) => {
    world(on, { [SHIP]: PLAN }, {}, {}, layout);

    await $.command.run(run("plan ship"));
    const ui = await $.ui.mount(pane("terminal"));
    await $.ui.focus({ component: "Pane", requestId: "omca", element: "task-1", origin: { kind: "person" } });

    expect((await ui.find({ key: "task-1" }))?.props["autoFocus"]).toBe(true);
    expect((await ui.find({ key: "task-2" }))?.props["autoFocus"]).toBeUndefined();
    expect((await ui.find({ key: "line-task-1" }))?.props["backgroundColor"]).toBe("selectionBg");
    expect((await ui.find({ key: "line-task-2" }))?.props["backgroundColor"]).toBeUndefined();
    expect(drawnNode(await ui.drawn(), "line-task-2")?.hover).toEqual({ backgroundColor: "selectionBg" });
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
    expect((await ui.find({ key: "b" }))?.props["label"]).toBe("Board");
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

const FILES = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${POSIX.plans}/plan-${i}.md`, LONG]));

const DOCK: Size = { columns: 120, rows: 20, placement: "dock" };

async function windowed($: Engine, on: On, files: Record<string, string>, args: string, size: Size = DOCK, keys: readonly string[] = []) {
  world(on, files);
  const engine: number[] = [];
  on("ui.scroll", (_$, e) => (engine.push(e.by), {}));
  await $.command.run(run(args));
  const ui = await $.ui.mount(pane("terminal", size));
  for (const key of keys) await ui.press({ key });
  const current = async () => (await ui.findAll({ type: "Button" })).filter((b) => b.props["autoFocus"] === true).map((b) => b.key);
  // Shorter than a page is a wheel tick, which comes with a pointer; an arrow goes the ring's way.
  const key = async (by: number, contentRows = 17, bodyRows = 16, isWheel = Math.abs(by) < bodyRows) => {
    const pointer = isWheel ? { pointer: { column: 4, row: 6 } } : {};
    await $.ui.scroll({ ...SCROLL, ...pointer, by, bodyRows, contentRows });
    return current();
  };
  return { ui, engine, current, key };
}

test("on the board a page key moves the cursor by the tasks the window shows, Home and End go to the ends, and a wheel tick moves it by its rows", async ($, on) => {
  const { ui, engine, current, key } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long");
  expect(await current()).toEqual(["task-1"]);

  expect(await key(16)).toEqual(["task-9"]);
  expect(await key(16)).toEqual(["task-18"]);
  expect(await key(-16)).toEqual(["task-9"]);
  expect(await key(17)).toEqual(["task-30"]);
  expect(await key(16)).toEqual(["task-30"]);
  expect(await key(-17)).toEqual(["task-1"]);
  expect(await key(-16)).toEqual(["task-1"]);

  expect(await key(1)).toEqual(["task-2"]);
  expect(await key(3)).toEqual(["task-5"]);
  expect(await key(-3)).toEqual(["task-2"]);
  expect(await key(-3)).toEqual(["task-1"]);
  expect(engine).toEqual([]);
  await ui.unmount();
});

test("on the Sections list a page key moves the pointer by the rows the window shows, Home and End go to the ends, and a wheel tick moves it by its rows", async ($, on) => {
  const { ui, engine, current, key } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long", DOCK, ["t"]);
  expect(await current()).toEqual(["row-1"]);

  expect(await key(16)).toEqual(["row-7"]);
  expect(await key(16)).toEqual(["row-14"]);
  expect(await key(-16)).toEqual(["row-7"]);
  expect(await key(17)).toEqual(["row-30"]);
  expect(await key(16)).toEqual(["row-30"]);
  expect(await key(-17)).toEqual(["row-1"]);
  expect(await key(-16)).toEqual(["row-1"]);

  expect(await key(1)).toEqual(["row-2"]);
  expect(await key(3)).toEqual(["row-5"]);
  expect(await key(-3)).toEqual(["row-2"]);
  expect(await key(-3)).toEqual(["row-1"]);
  expect(engine).toEqual([]);
  await ui.unmount();
});

test("where the body and the tree are the same height a page key pages and does not jump to the end", async ($, on) => {
  const inline: Size = { columns: 80, rows: 40, placement: "inline" };
  const { ui, current, key } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long", inline, ["t"]);
  expect(await current()).toEqual(["row-1"]);
  expect(await key(12, 12, 12)).toEqual(["row-6"]);
  expect(await key(-12, 12, 12)).toEqual(["row-1"]);
  await ui.unmount();
});

test("on the Plans list a page key, Home and End and a wheel tick move the pointer over the plans", async ($, on) => {
  const { ui, engine, current, key } = await windowed($, on, FILES, "plan");
  expect(await current()).toEqual(["pick-0"]);

  expect(await key(17)).toEqual(["pick-11"]);
  expect(await key(-17)).toEqual(["pick-0"]);
  expect(await key(16)).toEqual(["pick-7"]);
  expect(await key(-16)).toEqual(["pick-0"]);
  expect(await key(1)).toEqual(["pick-1"]);
  expect(await key(-3)).toEqual(["pick-0"]);
  expect(engine).toEqual([]);
  await ui.unmount();
});

test("on a section's page and a task's page the scroll keys reach the engine, which scrolls the page", async ($, on) => {
  const { ui, engine, key } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long", DOCK, ["task-1"]);
  for (const by of [16, 31, -16]) await key(by, 31);
  await ui.press({ key: "b" });
  await ui.press({ key: "t" });
  await ui.press({ key: "row-1" });
  for (const by of [16, 31, -31, -16]) await key(by, 31);
  await key(1, 31, 16, false);
  expect(engine).toEqual([16, 31, -16, 16, 31, -31, -16, 1]);
  await ui.unmount();
});

test("every Plan view names Esc as the way out", async ($, on) => {
  const { ui } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long");
  expect(await ui.find({ type: "Text", text: "↑↓ move · enter open · esc close" })).toBeDefined();

  await ui.press({ key: "task-1" });
  expect(await ui.find({ type: "Text", text: "↑↓ scroll · esc close" })).toBeDefined();

  await ui.press({ key: "b" });
  await ui.press({ key: "t" });
  expect(await ui.find({ type: "Text", text: "↑↓ move · enter open · esc close" })).toBeDefined();

  await ui.press({ key: "l" });
  expect(await ui.find({ type: "Text", text: "↑↓ move · enter open · esc close" })).toBeDefined();

  await ui.press({ key: "pick-0" });
  await ui.press({ key: "t" });
  await ui.press({ key: "row-1" });
  expect(await ui.find({ type: "Text", text: "↑↓ scroll · esc close" })).toBeDefined();
  await ui.unmount();
});

// The board: two milestones, done, open and blocked tasks, files changed before and after the
// ledger's runs, a task without files, a missing file, and a backlog of plain bullets.
const BOARD_PATH = `${ROOT}/plans/board.md`;
const BOARD = [
  "# Ship the board",
  "",
  "**Scope**: 6 files | **Parallel Execution**: YES - 2 waves | **Status**: FINAL",
  "",
  "## TODOs",
  "### Milestone 1: Core",
  "- [x] 1. Parse the plan",
  "  - File: `src/parse.ts`",
  "  - Do: Parse every task.",
  "  - Done when: `bun test src/parse.spec.ts` exits 0",
  "- [x] 2. Prove each task",
  "  - File: `src/proof.ts`, `src/proof.spec.ts`",
  "  - Do: Compare the files' change times with the ledger.",
  "  - Done when: `bun test src/proof.spec.ts` exits 0",
  "  - Depends: 1",
  "### Milestone 2: Board",
  "- [ ] 3. Draw the board",
  "  - File: `hooks/plan.ts`",
  "  - Do: Draw **rows** and chips.",
  "  - Done when: `just test-mod` exits 0",
  "  - Depends: 2",
  "  - Must NOT: add an option.",
  "- [ ] 4. Wire the hotkeys",
  "  - File: `hooks/keys.ts`, `hooks/gone.ts`",
  "  - Done when: `just ci` exits 0",
  "  - Depends: 3",
  "- [ ] 5. Write the docs",
  "  - Done when: the README shows the board.",
  "",
  "## Deferred backlog",
  "### Later",
  "- **The Hill** (L). A plain bullet, never a task.",
  "",
].join("\n");

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const HOUR = 3_600_000;
const entry = (type: string, command: string, exit: number, at: number) => ({
  type,
  command,
  exit_code: exit,
  output_snippet: "ok",
  timestamp: new Date(at).toISOString(),
  verified_by: "executor",
});
const PASSING = [
  entry("test", "bun test src/parse.spec.ts", 0, NOW - 2 * HOUR),
  entry("lint", "just lint", 1, NOW - HOUR),
  entry("test", "just test-mod", 0, NOW - HOUR / 2),
];
const CHANGED: Readonly<Record<string, number>> = {
  "src/parse.ts": NOW - 3 * HOUR,
  "src/proof.ts": NOW - 3 * HOUR,
  "src/proof.spec.ts": NOW - 2.5 * HOUR,
  "hooks/plan.ts": NOW - HOUR / 4,
  "hooks/keys.ts": NOW - 3 * HOUR,
};

const PAGE: Size = { columns: 80, rows: 40, placement: "dock" };
const INLINE_TIER: Size = { columns: 160, rows: 50, placement: "dock" };
const SPLIT: Size = { columns: 230, rows: 50, placement: "dock" };

const SPAWN = {
  tool_use_id: "toolu_1",
  prompt: "Task 3: draw the board\nRead hooks/plan.ts first.",
  description: "Draw the board",
  subagentType: "oh-my-claudeagent:executor",
  provider: { plugin: "oh-my-claudeagent", tier: "user" },
  parentModel: "claude-opus-5-5",
  background: true,
  fork: false,
} as const;

function boardWorld(on: On, entries: readonly object[] = PASSING, env: Record<string, string> = {}, plan = BOARD, isCopied = true) {
  const w = world(
    on,
    {
      [BOARD_PATH]: plan,
      [BOULDER]: JSON.stringify({ plans: { board: { active_plan: BOARD_PATH } }, bindings: { [SESSION]: { plan_name: "board" } } }),
      [LEDGER]: JSON.stringify({ entries }),
    },
    {},
    env,
  );
  for (const [path, mtimeMs] of Object.entries(CHANGED)) w.files.set(`${ROOT}/${path}`, { text: "x", mtimeMs });
  const fills: string[] = [];
  const copies: string[] = [];
  on("prompt.fill", (_$, e) => (fills.push(e.text), { isFilled: true }));
  on("ui.copy", (_$, e) => (copies.push(e.text), { value: isCopied ? { isCopied: true } : { isCopied: false, reason: "no-clipboard" } }));
  on("agent.spawn", () => ({ model: "claude-sonnet-5-5", agentId: "a-1" }));
  return { w, fills, copies };
}

type Drawn = { type: string; props?: Record<string, unknown>; hover?: unknown; children?: unknown };

function isDrawn(value: unknown): value is Drawn {
  return typeof value === "object" && value !== null && "type" in value;
}

function drawnNode(tree: unknown, key: string): Drawn | undefined {
  if (!isDrawn(tree)) return undefined;
  if (tree.props?.["key"] === key) return tree;
  const children = Array.isArray(tree.children) ? tree.children : [tree.children];
  for (const child of children) {
    const found = drawnNode(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

type Span = { text: string; color?: unknown; backgroundColor?: unknown; bold?: unknown; dimColor?: unknown };

// Every drawn run of text with the style its own element gives it, Button labels included.
function spans(node: unknown): Span[] {
  if (typeof node !== "object" || node === null || !("type" in node)) return [];
  const props: Record<string, unknown> = "props" in node && typeof node.props === "object" && node.props !== null ? (node.props as Record<string, unknown>) : {};
  const children: unknown[] = "children" in node ? (Array.isArray(node.children) ? node.children : [node.children]) : [];
  if (node.type === "Button") return [{ text: String(props["label"]), ...(props["dimColor"] === true ? { dimColor: true } : {}) }];
  return children.flatMap((child) => {
    if (typeof child !== "string") return spans(child);
    const style = Object.fromEntries(["color", "backgroundColor", "bold", "dimColor"].flatMap((name) => (props[name] === undefined ? [] : [[name, props[name]]])));
    return node.type === "Text" ? [{ text: child, ...style }] : [];
  });
}

async function mountBoard($: Engine, size: Size, surface: "terminal" | "desktop" = "terminal") {
  await $.command.run(run("plan", size.columns));
  return $.ui.mount(pane(surface, size));
}

test("the board shows the plan's Status, progress, proof and next task, then each milestone with its rows", async ($, on) => {
  boardWorld(on);
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await mountBoard($, PAGE, surface);
    expect(rows(await ui.drawn()).slice(2)).toEqual([
      "Ship the board FINAL  ████████▍███▋████████ 2/5 · ⊘ 1 blocked✓ 3 proven · ! 1 unproven · ✗ 0 failednext 3 Draw the board",
      " ",
      "── Milestone 1: Core ── ████████ 2/2 ──────────────",
      "✓ 1 Parse the plan                          PROVEN ",
      "✓ 2 Prove each task                         PROVEN ",
      "── Milestone 2: Board ── ████████ 0/3 ─────────────",
      "○ 3 Draw the board                        UNPROVEN ",
      "⊘ 4 Wire the hotkeys          blocked by 3  PROVEN ",
      "○ 5 Write the docs                                 ",
      " ",
      "k: Run  s: Start  c: Copy  e: Evidence  o: Open",
      "x: Failing  f: Find  t: Sections  l: Plans",
      "↑↓ move · enter open · esc close",
    ]);
    expect(await ui.find({ type: "Text", text: /Hill/ })).toBeUndefined();
    const header = await ui.find({ key: "plan-header" });
    expect(header?.props["borderColor"]).toBe("planMode");
    expect(spans(header).filter((span) => !/^[\s█▏▎▍▌▋▊▉]*$/.test(span.text))).toEqual([
      { text: "Ship the board", color: "text", bold: true },
      { text: " FINAL ", color: "inverseText", backgroundColor: "planMode", bold: true },
      { text: " 2/5", bold: true },
      { text: " · ", color: "inactive" },
      { text: "⊘", color: "warning" },
      { text: " 1 blocked" },
      { text: "✓", color: "success" },
      { text: " 3 proven" },
      { text: " · ", color: "inactive" },
      { text: "!", color: "warning" },
      { text: " 1 unproven" },
      { text: " · ", color: "inactive" },
      { text: "✗", color: "inactive" },
      { text: " 0 failed", color: "inactive" },
      { text: "next ", color: "inactive" },
      { text: "3 ", color: "claude", bold: true },
      { text: "Draw the board", color: "text" },
    ]);
    await ui.unmount();
  }
});

test("each row carries its state as a glyph, a word and a color, and done rows are dim", async ($, on) => {
  boardWorld(on);
  const ui = await mountBoard($, PAGE);
  const row = async (n: number) => spans(await ui.find({ key: `line-task-${n}` })).filter((span) => span.text.trim() !== "");
  expect(await row(1)).toEqual([
    { text: "✓ ", color: "success" },
    { text: "1", dimColor: true },
    { text: "Parse the plan", dimColor: true },
    { text: " PROVEN ", color: "inverseText", backgroundColor: "success", bold: true },
  ]);
  expect(await row(3)).toEqual([
    { text: "○ ", color: "text", bold: true },
    { text: "3", color: "text", bold: true },
    { text: "Draw the board" },
    { text: " UNPROVEN ", color: "inverseText", backgroundColor: "warning", bold: true },
  ]);
  expect(await row(4)).toEqual([
    { text: "⊘ ", color: "warning" },
    { text: "4" },
    { text: "Wire the hotkeys" },
    { text: "blocked by 3", color: "inactive" },
    { text: " PROVEN ", color: "inverseText", backgroundColor: "success", bold: true },
  ]);
  expect(await row(5)).toEqual([{ text: "○ " }, { text: "5" }, { text: "Write the docs" }]);

  await $.ui.focus({ component: "Pane", requestId: "omca", element: "task-4", origin: { kind: "person" } });
  expect((await row(3)).slice(0, 3)).toEqual([{ text: "○ " }, { text: "3", color: "text", bold: true }, { text: "Draw the board" }]);
  expect((await row(5))[1]).toEqual({ text: "5" });
  await ui.unmount();
});

test("a running agent whose prompt names a task marks that task in progress in the agent's color", async ($, on) => {
  const { w } = boardWorld(on);
  await $.command.run(run("plan", SPLIT.columns));
  await $.agent.spawn(SPAWN);
  w.agents = [{ id: "a-1", description: "Draw the board", type: "oh-my-claudeagent:executor", status: "running" }];
  const ui = await $.ui.mount(pane("terminal", PAGE));

  expect((await ui.find({ key: "line-task-3" }))?.text).toBe("◐ 3 Draw the board            ◆ executor  UNPROVEN ");
  expect(spans(await ui.find({ key: "line-task-3" })).find((span) => span.text.startsWith("◆"))).toEqual({ text: "◆ executor", color: "text", bold: true });
  await $.ui.focus({ component: "Pane", requestId: "omca", element: "task-4", origin: { kind: "person" } });
  expect(spans(await ui.find({ key: "line-task-3" })).filter((span) => /[◐◆]/.test(span.text))).toEqual([
    { text: "◐ ", color: "claude" },
    { text: "◆ executor", color: "green_FOR_SUBAGENTS_ONLY" },
  ]);
  expect((await ui.find({ key: "line-task-4" }))?.text).toBe("⊘ 4 Wire the hotkeys          blocked by 3  PROVEN ");
  const header = spans(await ui.find({ key: "plan-header" }));
  expect(header.slice(-2)).toEqual([
    { text: "◆ executor", color: "green_FOR_SUBAGENTS_ONLY" },
    { text: " on 3", color: "inactive" },
  ]);
  expect(header.find((span) => span.text === " 2/5")).toEqual({ text: " 2/5", bold: true });
  await ui.unmount();
});

test("FAILED marks every task whose newest run since its change failed, and an unreadable ledger proves nothing", async ($, on) => {
  const { w } = boardWorld(on, [...PASSING, entry("build", "bun run build", 2, NOW - HOUR / 8)]);
  const ui = await mountBoard($, PAGE);
  expect((await ui.find({ key: "line-task-1" }))?.text).toBe("✓ 1 Parse the plan                          FAILED ");
  expect((await ui.find({ key: "line-task-3" }))?.text).toBe("○ 3 Draw the board                          FAILED ");
  expect(await ui.find({ type: "Text", text: "✗ 4 failed" })).toBeDefined();

  await ui.press({ key: "x" });
  expect(rows(await ui.drawn()).slice(3, 11)).toEqual([
    "Find:   FAILING  4 of 5",
    " ",
    "── Milestone 1: Core ── ████████ 2/2 ──────────────",
    "✓ 1 Parse the plan                          FAILED ",
    "✓ 2 Prove each task                         FAILED ",
    "── Milestone 2: Board ── ████████ 0/3 ─────────────",
    "○ 3 Draw the board                          FAILED ",
    "⊘ 4 Wire the hotkeys          blocked by 3  FAILED ",
  ]);
  await ui.press({ key: "x" });

  write(w, LEDGER, "{ not json");
  await w.clock.advance(2000);
  await ui.redraw();
  expect((await ui.find({ key: "line-task-1" }))?.text).toBe("✓ 1 Parse the plan                                 ");
  const header = spans(await ui.find({ key: "plan-header" }));
  const cross = header.findIndex((span) => span.text === "✗");
  expect(header[cross]?.color).toBe("error");
  expect(header[cross + 1]?.text).toStartWith(" evidence ledger unreadable: ");
  await ui.unmount();
});

test("the inline tier expands the focused task under its row", async ($, on) => {
  boardWorld(on);
  const ui = await mountBoard($, INLINE_TIER);
  const drawn = rows(await ui.drawn());
  const at = drawn.findIndex((row) => row.startsWith("○ 3 "));
  expect(drawn.slice(at, at + 6)).toEqual([
    "○ 3 Draw the board                                        UNPROVEN ",
    "     Draw **rows** and chips.",
    "     $ just test-mod",
    "     hooks/plan.ts 15m",
    "     ! no run since its files changed",
    "⊘ 4 Wire the hotkeys                          blocked by 3  PROVEN ",
  ]);
  await $.ui.focus({ component: "Pane", requestId: "omca", element: "task-1", origin: { kind: "person" } });
  const moved = rows(await ui.drawn());
  const first = moved.findIndex((row) => row.startsWith("✓ 1 "));
  expect(moved.slice(first + 1, first + 5)).toEqual([
    "     Parse every task.",
    "     $ bun test src/parse.spec.ts",
    "     src/parse.ts 3h",
    "     ✓ test exit 0 · just test-mod · 30m ago",
  ]);
  await ui.unmount();
});

test("an inline expansion whose listed files cannot be read says so, as the task page does", async ($, on) => {
  boardWorld(on, PASSING, {}, BOARD.replace("  - File: `hooks/plan.ts`", "  - File: `hooks/missing.ts`"));
  const ui = await mountBoard($, INLINE_TIER);
  const drawn = rows(await ui.drawn());
  const at = drawn.findIndex((row) => row.startsWith("○ 3 "));
  expect(drawn.slice(at + 3, at + 5)).toEqual(["     hooks/missing.ts not found", "     None of its files can be read, so no run can prove it."]);
  expect(spans(await ui.find({ key: "x-evidence" })).filter((span) => span.text.trim() !== "")).toEqual([
    { text: "None of its files can be read, so no run can prove it.", color: "inactive" },
  ]);
  await ui.unmount();
});

test("the split tier draws the focused task's detail beside the list", async ($, on) => {
  boardWorld(on);
  const ui = await mountBoard($, SPLIT);
  const detail = await ui.find({ key: "board-detail" });
  expect(detail?.props["overflow"]).toBe("hidden");
  expect(await ui.find({ type: "Text", text: "3. Draw the board" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: "Draw rows and chips." })).toMatchObject({ children: [{ children: ["Draw "] }, { props: { bold: true }, children: ["rows"] }, { children: [" and chips."] }] });
  expect(await ui.find({ type: "Text", text: "Must NOT: add an option." })).toMatchObject({ children: [{ props: { bold: true }, children: ["Must"] }, { children: [" "] }, { props: { bold: true }, children: ["NOT:"] }, { children: [" add an option."] }] });
  expect((await ui.find({ type: "Code" }))?.props).toMatchObject({ source: "$ just test-mod", language: "bash" });
  expect(spans(detail).filter((span) => span.backgroundColor !== undefined)).toEqual([
    { text: " OPEN ", color: "inverseText", backgroundColor: "inactive", bold: true },
    { text: " UNPROVEN ", color: "inverseText", backgroundColor: "warning", bold: true },
    { text: " ✓ 2 ", color: "inverseText", backgroundColor: "success", bold: true },
  ]);
  const texts = spans(detail).map((span) => span.text);
  expect(texts.slice(texts.indexOf("hooks/plan.ts"), texts.indexOf("hooks/plan.ts") + 3)).toEqual(["hooks/plan.ts", expect.stringMatching(/^ +$/), "changed 15m ago"]);
  expect(spans(detail).find((span) => span.text === "changed 15m ago")).toEqual({ text: "changed 15m ago", color: "warning" });
  await ui.unmount();
});

test("in the split tier a wheel tick over the detail scrolls it and leaves the cursor, and one over the list moves the cursor and puts the detail back at its top", async ($, on) => {
  boardWorld(on);
  const engine: number[] = [];
  on("ui.scroll", (_$, e) => (engine.push(e.by), {}));
  const ui = await mountBoard($, { columns: 230, rows: 20, placement: "dock" });
  const current = async () => (await ui.findAll({ type: "Button" })).filter((b) => b.props["autoFocus"] === true).map((b) => b.key);
  // The tab bar sits above the tab, then two header lines; the detail starts at column 58.
  const tick = (column: number, by: number) => $.ui.scroll({ ...SCROLL, by, bodyRows: 16, contentRows: 17, pointer: { column, row: 6 } });
  const above = async () => (await ui.find({ type: "Text", text: /^↑ \d+ more/ }))?.text.trim();
  expect(await current()).toEqual(["task-3"]);
  expect(await ui.find({ type: "Text", text: /^↓ more · wheel to scroll/ })).toBeDefined();
  expect(await above()).toBeUndefined();

  await tick(60, 1);
  await tick(60, 2);
  expect(await above()).toBe("↑ 3 more");
  expect(await current()).toEqual(["task-3"]);
  expect(await ui.find({ type: "Text", text: "3. Draw the board" })).toBeUndefined();

  for (let tickNo = 0; tickNo < 10; tickNo += 1) await tick(60, 3);
  expect(await ui.find({ type: "Text", text: /^↓ more/ })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: "  ✓ test just test-mod exit 0 · 30m ago" })).toBeDefined();
  expect(await current()).toEqual(["task-3"]);

  await tick(10, 1);
  expect(await current()).toEqual(["task-4"]);
  expect(await above()).toBeUndefined();
  expect(await ui.find({ type: "Text", text: "4. Wire the hotkeys" })).toBeDefined();
  expect(engine).toEqual([]);
  await ui.unmount();
});

test("in the split tier a press on another task selects it and a press on the task under the cursor opens its page; elsewhere a press opens", async ($, on) => {
  boardWorld(on);
  const split = await mountBoard($, SPLIT);
  expect((await split.find({ key: "task-1" }))?.props["label"]).toBe("Parse the plan");
  await split.press({ key: "task-1" });
  expect((await split.find({ key: "task-1" }))?.props["autoFocus"]).toBe(true);
  expect(await split.find({ type: "Text", text: "1. Parse the plan" })).toBeDefined();
  expect(await split.find({ type: "Text", text: "1 / 5" })).toBeUndefined();
  await split.press({ key: "task-1" });
  expect(await split.find({ type: "Text", text: "1 / 5" })).toBeDefined();
  await split.press({ key: "b" });
  await split.unmount();

  const page = await mountBoard($, PAGE);
  await page.press({ key: "task-2" });
  expect(await page.find({ type: "Text", text: "2 / 5" })).toBeDefined();
  await page.unmount();
});

test("a file changed moments ago reads changed just now, never now ago", async ($, on) => {
  const { w } = boardWorld(on);
  w.files.set(`${ROOT}/hooks/plan.ts`, { text: "x", mtimeMs: NOW - 1000 });
  const ui = await mountBoard($, SPLIT);
  await ui.press({ key: "task-3" });
  const drawn = spreadRows(await ui.drawn());
  expect(drawn.filter((row) => row.includes("just now")).map((row) => row.trim().replace(/\s+/g, " "))).toEqual([
    "hooks/plan.ts changed just now",
    "! No test, build or lint run since its files changed just now.",
  ]);
  expect(drawn.some((row) => row.includes("now ago"))).toBe(false);
  await ui.unmount();
});

test("Enter opens a task's page with its files and the runs that prove it; n, p and b move between pages and the board", async ($, on) => {
  boardWorld(on);
  const ui = await mountBoard($, PAGE);
  await ui.press({ key: "task-3" });
  expect(spreadRows(await ui.drawn()).slice(2)).toEqual([
    "Ship the board3 / 5",
    "b: Board  p: Prev  n: Next  k: Run check",
    "s: Start here  c: Copy  e: Evidence",
    "─".repeat(51),
    "3. Draw the board",
    " OPEN   UNPROVEN ",
    " ",
    "Do",
    "Draw rows and chips.",
    "Must NOT: add an option.",
    " ",
    "Done when",
    "",
    "exits 0",
    " ",
    "Depends",
    " ✓ 2 ",
    " ",
    "Files",
    "  hooks/plan.ts                     changed 15m ago",
    " ",
    "Evidence",
    "  ! No test, build or lint run since its files",
    "    changed 15m ago.",
    "  Last pass, before that change:",
    "  ✓ test just test-mod exit 0 · 30m ago",
    "↑↓ scroll · esc close",
  ]);
  expect(await ui.find({ type: "Text", text: "exits 0" })).toBeDefined();
  expect((await ui.find({ type: "Code" }))?.props).toMatchObject({ source: "$ just test-mod", language: "bash" });

  await ui.press({ key: "n" });
  const four = spreadRows(await ui.drawn());
  expect(four.slice(four.indexOf("Files"))).toEqual([
    "Files",
    "  hooks/keys.ts                      changed 3h ago",
    "  hooks/gone.ts                           not found",
    " ",
    "Evidence",
    "  ✓ test just test-mod exit 0 · 30m ago",
    "  ✗ lint just lint exit 1 · 1h ago",
    "  ✓ test bun test src/parse.spec.ts exit 0 · 2h ago",
    "↑↓ scroll · esc close",
  ]);
  expect(four).toContain(" BLOCKED   PROVEN ");
  expect(four).toContain(" ○ 3  blocked by 3");

  await ui.press({ key: "n" });
  const five = spreadRows(await ui.drawn());
  expect(five.slice(five.indexOf("Evidence"))).toEqual(["Evidence", "  Lists no files, so no run can prove it.", "↑↓ scroll · esc close"]);
  expect((await ui.find({ key: "n" }))?.props["dimColor"]).toBe(true);
  expect((await ui.find({ key: "k" }))?.props["dimColor"]).toBe(true);

  await ui.press({ key: "p" });
  await ui.press({ key: "b" });
  expect((await ui.find({ key: "task-4" }))?.props["autoFocus"]).toBe(true);
  await ui.unmount();
});

test("k, s and c fill the prompt or copy the focused task, never submitting, and e opens the Evidence tab", async ($, on) => {
  const { fills, copies } = boardWorld(on);
  const ui = await mountBoard($, PAGE);

  await ui.press({ key: "k" });
  await ui.press({ key: "s" });
  await ui.press({ key: "c" });
  expect(fills).toEqual([
    "Run `just test-mod` to check task 3, then record the result with evidence_log.",
    "/oh-my-claudeagent:start-work /work/plans/board.md from task 3",
  ]);
  expect(copies).toEqual([
    "- [ ] 3. Draw the board\n  - File: `hooks/plan.ts`\n  - Do: Draw **rows** and chips.\n  - Done when: `just test-mod` exits 0\n  - Depends: 2\n  - Must NOT: add an option.",
  ]);
  expect(spans(await ui.drawn()).at(-1)).toEqual({ text: "Copied task 3.", color: "success" });

  await $.ui.focus({ component: "Pane", requestId: "omca", element: "task-5", origin: { kind: "person" } });
  expect((await ui.find({ key: "k" }))?.props["dimColor"]).toBe(true);
  await ui.press({ key: "k" });
  expect(fills).toHaveLength(2);
  expect(spans(await ui.drawn()).at(-1)).toEqual({ text: "Task 5 names no check command.", color: "warning" });
  await $.ui.focus({ component: "Pane", requestId: "omca", element: "task-2", origin: { kind: "person" } });
  expect((await ui.find({ key: "s" }))?.props["dimColor"]).toBe(true);

  await ui.press({ key: "e" });
  expect((await ui.find({ key: "3" }))?.props["dimColor"]).toBeUndefined();
  expect((await ui.find({ key: "2" }))?.props["dimColor"]).toBe(true);
  await ui.unmount();
});

test("a copy the surface refuses says so", async ($, on) => {
  boardWorld(on, PASSING, {}, BOARD, false);
  const ui = await mountBoard($, PAGE);
  await ui.press({ key: "c" });
  expect(spans(await ui.drawn()).at(-1)).toEqual({ text: "Could not copy task 3: no-clipboard.", color: "error" });
  await ui.unmount();
});

test("o keeps open tasks, f opens the Find field, and a filter that matches nothing says so", async ($, on) => {
  boardWorld(on);
  const ui = await mountBoard($, PAGE);

  await ui.press({ key: "o" });
  expect((await ui.find({ key: "o" }))?.props["dimColor"]).toBeUndefined();
  expect(rows(await ui.drawn()).slice(3, 9)).toEqual([
    "Find:   OPEN  3 of 5",
    " ",
    "── Milestone 2: Board ── ████████ 0/3 ─────────────",
    "○ 3 Draw the board                        UNPROVEN ",
    "⊘ 4 Wire the hotkeys          blocked by 3  PROVEN ",
    "○ 5 Write the docs                                 ",
  ]);
  await ui.press({ key: "o" });
  expect((await ui.find({ key: "o" }))?.props["dimColor"]).toBe(true);

  await ui.press({ key: "f" });
  expect((await ui.find({ key: "filter" }))?.props).toMatchObject({ label: "Find", placeholder: "number, title or path", value: "" });
  await ui.input({ key: "filter", text: "hot", kind: "change" });
  expect(rows(await ui.drawn()).filter((row) => /^[✓○⊘◐] /.test(row))).toEqual(["⊘ 4 Wire the hotkeys          blocked by 3  PROVEN "]);
  await ui.input({ key: "filter", text: "keys.ts" });
  expect(await ui.find({ key: "filter" })).toBeUndefined();
  expect(rows(await ui.drawn())[3]).toBe("Find: keys.ts 1 of 5");
  expect((await ui.find({ key: "task-4" }))?.props["autoFocus"]).toBe(true);

  await ui.press({ key: "f" });
  await ui.input({ key: "filter", text: "zzz" });
  expect(await ui.find({ type: "Text", text: "No task matches the filter." })).toBeDefined();
  expect((await ui.find({ key: "k" }))?.props["dimColor"]).toBe(true);
  await ui.unmount();
});

test("OMCA_GLYPHS=ascii draws the board, its chips and bars from the ASCII set", async ($, on) => {
  boardWorld(on, PASSING, { OMCA_GLYPHS: "ascii" });
  await $.command.run(run("plan", 80));
  await $.agent.spawn(SPAWN);
  const ui = await $.ui.mount(pane("terminal", PAGE));
  expect(rows(await ui.drawn()).slice(2)).toEqual([
    "Ship the board[FINAL] [#######====////....] 2/5 | / 1 blocked+ 3 proven | ! 1 unproven | x 0 failednext 3 Draw the board@ executor on 3",
    " ",
    "-- Milestone 1: Core -- [######] 2/2 --------------",
    "+ 1 Parse the plan                         [PROVEN]",
    "+ 2 Prove each task                        [PROVEN]",
    "-- Milestone 2: Board -- [......] 0/3 -------------",
    "~ 3 Draw the board            @ executor [UNPROVEN]",
    "/ 4 Wire the hotkeys          blocked by 3 [PROVEN]",
    "o 5 Write the docs                                 ",
    " ",
    "k: Run  s: Start  c: Copy  e: Evidence  o: Open",
    "x: Failing  f: Find  t: Sections  l: Plans",
    "^v move - enter open - esc close",
  ]);
  await ui.unmount();
});

test("the board reads nothing while it draws and shows a loading line until the plan is read", async ($, on) => {
  const { w } = boardWorld(on);
  const release = hold(w, BOARD_PATH);
  const opening = $.command.run(run("plan", 80));
  await w.clock.settle();
  const ui = await $.ui.mount(pane("terminal", PAGE));
  await ui.press({ key: "2" });
  expect(rows(await ui.drawn()).slice(2)).toEqual(["Reading the plan…"]);
  release();
  await opening;
  w.reads.length = 0;
  await ui.redraw();
  await ui.press({ key: "task-3" });
  await ui.press({ key: "b" });
  expect(w.reads).toEqual([]);
  await ui.unmount();
});

test("commands, paths and copies are masked before they are drawn or filled", async ($, on) => {
  const secret = "ghp_" + "a".repeat(36);
  const plan = BOARD.replace("`just test-mod` exits 0", `\`GH_TOKEN=${secret} just test-mod\` exits 0`);
  const { fills, copies } = boardWorld(on, PASSING, {}, plan);
  const ui = await mountBoard($, SPLIT);
  expect((await ui.find({ type: "Code" }))?.props["source"]).toBe("$ GH_TOKEN=‹masked› just test-mod");
  await ui.press({ key: "k" });
  await ui.press({ key: "c" });
  expect(fills).toEqual(["Run `GH_TOKEN=‹masked› just test-mod` to check task 3, then record the result with evidence_log."]);
  expect(copies[0]).toContain("- Done when: `GH_TOKEN=‹masked› just test-mod` exits 0");
  expect(spans(await ui.drawn()).at(-1)).toEqual({ text: "Copied task 3 with 1 secret masked.", color: "success" });
  await ui.unmount();
});

const MORE = Array.from({ length: 14 }, (_, i) =>
  [
    `- [ ] ${i + 6}. Port the number ${i + 6} onto the shared router`,
    `  - File: \`src/port${i + 6}.ts\``,
    `  - Do: Move number ${i + 6} behind one function, keep the public signature and delete the old adapter once every caller uses the new path.`,
    `  - Done when: \`just test-port ${i + 6}\` exits 0`,
    "",
  ].join("\n"),
).join("\n");
const LONG_BOARD = BOARD.replace("## Deferred backlog", `### Milestone 3: Port\n${MORE}\n## Deferred backlog`);

const SHORT: Size = { columns: 80, rows: 24, placement: "inline" };
const BODY_ROWS = (size: Size) => (size.placement === "dock" ? size.rows - 4 : Math.min(12, Math.max(7, Math.floor(size.rows / 3) - 2)));

// Rows a drawn tree takes, a Box with a height as that height and Markdown as one row.
function heightOf(node: unknown): number {
  if (typeof node === "string") return 1;
  if (!isNode(node)) return 0;
  const props = node.props ?? {};
  if (node.type === "Code") return String(props["source"]).split("\n").length;
  if (node.type !== "Box") return 1;
  if (typeof props["height"] === "number") return props["height"];
  const inner = childrenOf(node).map(heightOf);
  return props["flexDirection"] === "row" ? Math.max(0, ...inner) : inner.reduce((sum, each) => sum + each, 0);
}

test("every Plan view hands the engine no more rows than the pane has, and one blank row past them only where a list is cut", async ($, on) => {
  const { w } = boardWorld(on, PASSING, {}, LONG_BOARD);
  w.files.set(`${ROOT}/plans/other.md`, { text: BOARD, mtimeMs: NOW });
  const sizes: Size[] = [
    SHORT,
    { columns: 100, rows: 30, placement: "inline" },
    { columns: 120, rows: 24, placement: "dock" },
    { columns: 120, rows: 40, placement: "dock" },
    { columns: 160, rows: 16, placement: "dock" },
    { columns: 200, rows: 50, placement: "dock" },
    { columns: 230, rows: 16, placement: "dock" },
  ];
  for (const size of sizes) {
    await $.command.run(run("plan", size.columns));
    const ui = await $.ui.mount(pane("terminal", size));
    const focused = async () => (await ui.findAll({ type: "Button" })).find((button) => button.props["autoFocus"] === true)?.key ?? "";
    const check = async (name: string) => {
      const children = topRows(await ui.drawn());
      const used = children.reduce<number>((sum, child) => sum + heightOf(child), 0);
      const chrome = size.placement === "dock" && BODY_ROWS(size) >= 30 ? 2 : 1;
      const room = BODY_ROWS(size) - chrome;
      const pad = textOf(children.at(-1)) === " " && used - chrome > room;
      expect(used - chrome - (pad ? 1 : 0), `${size.columns}x${size.rows} ${size.placement} ${name}`).toBeLessThanOrEqual(room);
    };
    await check("board");
    await ui.press({ key: "f" });
    await check("find");
    await ui.input({ key: "filter", text: "port", kind: "change" });
    await check("filtered");
    await ui.input({ key: "filter", text: "" });
    await ui.press({ key: await focused() });
    await check("task page");
    await ui.press({ key: "b" });
    await ui.press({ key: "t" });
    await check("sections");
    await ui.press({ key: await focused() });
    await check("section page");
    await ui.press({ key: "t" });
    await ui.press({ key: "l" });
    await check("plans");
    await ui.unmount();
  }
});

test("a short pane draws a one-line header, a list row with its cues and one key row, the rest as bare hotkeys", async ($, on) => {
  boardWorld(on);
  const ui = await mountBoard($, SHORT);
  expect(rows(await ui.drawn()).slice(1)).toEqual([
    " FINAL  Ship the board ██████████ 2/5 ✓ 3  ! 1",
    "  ↑ 2 more",
    `── Milestone 2: Board ── ████████ 0/3 ${"─".repeat(35)}`,
    `○ 3 Draw the board${" ".repeat(46)}UNPROVEN `,
    "  ↓ 2 more",
    "k: Run  s: Start  c: Copy  e: Evidence  o: Open  x:   f:   t:   l: ",
    " ",
  ]);
  expect((await ui.find({ key: "l" }))?.props["hotkey"]).toBe("l");
  await ui.unmount();
});

test("a filter on a short pane keeps its state and drops the milestone rows", async ($, on) => {
  boardWorld(on);
  const ui = await mountBoard($, SHORT);
  await ui.press({ key: "f" });
  await ui.input({ key: "filter", text: "hot" });
  expect(rows(await ui.drawn()).slice(1)).toEqual([
    " FINAL  Ship the board ██████████ 2/5 ✓ 3  ! 1",
    "Find: hot 1 of 5",
    " ",
    `⊘ 4 Wire the hotkeys${" ".repeat(32)}blocked by 3  PROVEN `,
    " ",
    "k: Run  s: Start  c: Copy  e: Evidence  o: Open  x:   f:   t:   l: ",
  ]);
  await ui.unmount();
});

test("the key rows are two from 30 rows or while the list leaves rows to spare, else one with the keys past it bare", async ($, on) => {
  boardWorld(on);
  const twoRows = ["k: Run  s: Start  c: Copy  e: Evidence  o: Open", "x: Failing  f: Find  t: Sections  l: Plans"];
  const tall = await mountBoard($, PAGE);
  expect(rows(await tall.drawn()).slice(-3)).toEqual([...twoRows, "↑↓ move · enter open · esc close"]);
  await tall.unmount();
  const spare = await mountBoard($, { columns: 120, rows: 20, placement: "dock" });
  expect(rows(await spare.drawn()).filter((row) => /^[kx]:/.test(row))).toEqual(twoRows);
  await spare.unmount();
});

test("a list that needs every row keeps one key row, the keys past it bare", async ($, on) => {
  boardWorld(on, PASSING, {}, LONG_BOARD);
  const low = await mountBoard($, { columns: 120, rows: 20, placement: "dock" });
  expect(rows(await low.drawn()).filter((row) => row.startsWith("k:"))).toEqual(["k: Run  s: Start  c:   e:   o:   x:   f:   t:   l: "]);
  await low.unmount();
});

test("a list shorter than its window cut ends in one blank row, and an uncut one in none", async ($, on) => {
  boardWorld(on, PASSING, {}, LONG_BOARD);
  const cut = await mountBoard($, { columns: 120, rows: 20, placement: "dock" });
  expect(rows(await cut.drawn()).slice(-2)).toEqual(["↑↓ move · enter open · esc close", " "]);
  await cut.unmount();
  const whole = await mountBoard($, { columns: 120, rows: 60, placement: "dock" });
  expect(rows(await whole.drawn()).at(-1)).toBe("↑↓ move · enter open · esc close");
  await whole.unmount();
});

test("when only a milestone heading is above the window it is drawn in place of the cue", async ($, on) => {
  boardWorld(on, PASSING, {}, LONG_BOARD);
  const ui = await mountBoard($, SHORT);
  await $.ui.focus({ component: "Pane", requestId: "omca", element: "task-2", origin: { kind: "person" } });
  const drawn = rows(await ui.drawn());
  expect(drawn[2]).toStartWith("── Milestone 1: Core ──");
  expect(drawn.some((row) => row.includes("↑"))).toBe(false);
  expect(drawn[5]).toBe("  ↓ 17 more");
  await ui.unmount();
});

test("the split tier needs 14 body rows, and below that the focused task's detail goes under its row", async ($, on) => {
  boardWorld(on);
  const split = await mountBoard($, { columns: 230, rows: 20, placement: "dock" });
  expect(await split.find({ key: "board-detail" })).toBeDefined();
  await split.unmount();
  const stacked = await mountBoard($, { columns: 230, rows: 16, placement: "dock" });
  expect(await stacked.find({ key: "board-detail" })).toBeUndefined();
  const drawn = rows(await stacked.drawn());
  const at = drawn.findIndex((row) => row.startsWith("○ 3 "));
  expect(drawn.slice(at + 1, at + 3)).toEqual(["     Draw **rows** and chips.", "     $ just test-mod"]);
  expect(drawn[at + 3]).toStartWith("⊘ 4 ");
  await stacked.unmount();
});

test("the detail under a row takes the rows left after two neighbours each side and wraps its facts into them", async ($, on) => {
  boardWorld(on, PASSING, {}, LONG_BOARD);
  const ui = await mountBoard($, INLINE_TIER);
  await $.ui.focus({ component: "Pane", requestId: "omca", element: "task-7", origin: { kind: "person" } });
  const drawn = rows(await ui.drawn());
  const at = drawn.findIndex((row) => row.startsWith("○  7 "));
  expect(drawn.slice(at + 1, at + 7)).toEqual([
    "     Move number 7 behind one function, keep the public signature",
    "     and delete the old adapter once every caller uses the new",
    "     path.",
    "     $ just test-port 7",
    "     src/port7.ts not found",
    "     None of its files can be read, so no run can prove it.",
  ]);
  expect(drawn[at + 7]).toStartWith("○  8 ");
  await ui.unmount();
});

test("the split list takes the width its longest title asks for, at least 56 cells and a cell short of the rule, its chips in words while titles fit", async ($, on) => {
  boardWorld(on);
  const ui = await mountBoard($, SPLIT);
  const tree = await ui.drawn();
  const column = drawnNode(tree, "board-split");
  const listWidth = Number((column?.children as Drawn[] | undefined)?.[0]?.props?.["width"]);
  expect(listWidth).toBeGreaterThanOrEqual(56);
  expect(drawnNode(tree, "line-task-4")?.props?.["width"]).toBe(listWidth - 1);
  const blocked = (await ui.find({ key: "line-task-4" }))?.text ?? "";
  expect(blocked).toContain("blocked by 3");
  expect(blocked).toContain("PROVEN");
  expect(blocked).toContain("Wire the hotkeys");
  await ui.unmount();
});

test("a done-when command is drawn once with its prompt, and the split detail wraps instead of cutting", async ($, on) => {
  boardWorld(on);
  const ui = await mountBoard($, SPLIT);
  expect((await ui.find({ type: "Code" }))?.props).toMatchObject({ source: "$ just test-mod", language: "bash" });
  expect(await ui.find({ type: "Text", text: /^exits 0$/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /just test-mod.*exits/ })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^ {4}15m ago\.$/ })).toBeDefined();
  await ui.unmount();
});

test("a task page and a section page keep their header and keys and scroll their body in a region", async ($, on) => {
  boardWorld(on, PASSING, {}, LONG_BOARD);
  const engine: number[] = [];
  on("ui.scroll", (_$, e) => (engine.push(e.by), {}));
  const ui = await mountBoard($, SHORT);
  await ui.press({ key: "task-3" });
  const top = spreadRows(await ui.drawn()).slice(1);
  expect(top).toHaveLength(7);
  expect(top.slice(0, 2)).toEqual(["Ship the board3 / 19", "b: Board  p: Prev  n: Next  k: Run  s: Start  c: Copy  e: Evidence"]);
  expect(top.slice(2, 5)).toEqual(["3. Draw the board", " OPEN   UNPROVEN ", " "]);
  expect(top.at(-2)).toStartWith("↓ more · wheel to scroll");
  expect(top.at(-1)).toBe(" ");

  await $.ui.scroll({ ...SCROLL, by: 1, bodyRows: 6, contentRows: 7 });
  expect(await ui.find({ type: "Text", text: /^↑ 1 more/ })).toBeDefined();
  await $.ui.scroll({ ...SCROLL, by: 1, bodyRows: 6, contentRows: 7, pointer: { column: 5, row: 4 } });
  expect(await ui.find({ type: "Text", text: /^↑ 2 more/ })).toBeDefined();
  expect(engine).toEqual([]);

  await ui.press({ key: "b" });
  await ui.press({ key: "t" });
  const row = (await ui.findAll({ type: "Button" })).find((button) => button.props["autoFocus"] === true);
  await ui.press({ key: row?.key ?? "" });
  const section = spreadRows(await ui.drawn()).slice(1);
  expect(section.some((row) => row.startsWith("[ ] 3. Draw the board"))).toBe(true);
  expect(section.length).toBeLessThanOrEqual(7);
  await ui.unmount();
});

test("the header gives up its proof note before the title drops under 40% of the width, and says why a proof is missing", async ($, on) => {
  const plan = LONG_BOARD.replace("# Ship the board", "# Ship the sample widget service rewrite").replace(/- File: .*\n/g, "- File: `absent.ts`\n");
  boardWorld(on, PASSING, {}, plan);
  const short = await mountBoard($, SHORT);
  const line = rows(await short.drawn())[1] ?? "";
  expect(line).toContain("Ship the sample widget service rewrite");
  expect(line).not.toContain("no listed file");
  await short.unmount();
  const card = await mountBoard($, PAGE);
  expect(await card.find({ type: "Text", text: "no listed file can be read" })).toBeDefined();
  await card.unmount();
});

test("the Sections list pads task numbers like the board", async ($, on) => {
  boardWorld(on, PASSING, {}, LONG_BOARD);
  const ui = await mountBoard($, { columns: 160, rows: 60, placement: "dock" });
  await ui.press({ key: "t" });
  const labels = (await ui.findAll({ type: "Button" })).map((button) => String(button.props["label"] ?? ""));
  expect(labels).toContain("    [x]  1. Parse the plan");
  expect(labels).toContain("    [ ] 10. Port the number 10 onto the shared router");
  await ui.unmount();
});

test("the Plans list shows each plan's progress and marks the bound one", async ($, on) => {
  const SHIP = `${POSIX.plans}/ship.md`;
  const zed = `${POSIX.plans}/zed.md`;
  const w = world(on, {
    [BOULDER]: JSON.stringify({ plans: { ship: { active_plan: SHIP } }, bindings: { [SESSION]: { plan_name: "ship" } } }),
    [SHIP]: PLAN,
    [zed]: PLAN.replace("- [ ] 2.", "- [x] 2."),
  });
  w.files.set(SHIP, { text: PLAN, mtimeMs: Date.UTC(2026, 0, 2) });
  w.files.set(zed, { text: PLAN.replace("- [ ] 2.", "- [x] 2."), mtimeMs: Date.UTC(2026, 9, 2) });
  await $.command.run(run("plan"));
  const ui = await $.ui.mount(pane("terminal", PAGE));
  await ui.press({ key: "l" });
  const listed = rows(await ui.drawn()).filter((row) => /^[❯ ] (ship|zed)/.test(row));
  expect(listed).toEqual([expect.stringMatching(/^ {2}zed\s+2\/2\s+2026-10-02$/), expect.stringMatching(/^❯ ship\s*bound\s+1\/2\s+2026-01-02$/)]);
  await ui.unmount();
});

test("with no plan the empty state wraps its notice, puts the path on its own line and says how a plan is made and bound", async ($, on) => {
  world(on, {});
  await $.command.run(run("plan"));
  const ui = await $.ui.mount(pane("terminal", PAGE));
  expect(rows(await ui.drawn()).slice(2)).toEqual([
    "No plan is bound to this session.",
    "No plans in",
    "~/.claude/plans",
    "Make one with /oh-my-claudeagent:plan, then bind it",
    "to this session with /oh-my-claudeagent:start-work.",
    "r: Reload",
  ]);
  await ui.unmount();
});
