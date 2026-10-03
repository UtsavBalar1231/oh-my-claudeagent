import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { BOULDER, hold, LAYOUTS, LEDGER, POSIX, pane, ROOT, rows, run, SESSION, type Size, world, write } from "./world.ts";

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

const FILES = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`${POSIX.plans}/plan-${i}.md`, LONG]));

const DOCK: Size = { columns: 120, rows: 20, placement: "dock" };

async function windowed($: Engine, on: On, files: Record<string, string>, args: string, size: Size = DOCK, keys: readonly string[] = []) {
  world(on, files);
  const engine: number[] = [];
  on("ui.scroll", (_$, e) => (engine.push(e.by), {}));
  await $.command.run(run(args));
  const ui = await $.ui.mount(pane("terminal", size));
  for (const key of keys) await ui.press({ key });
  const current = async () => (await ui.findAll({ type: "Button" })).filter((b) => b.props["autoFocus"] === true).map((b) => b.key);
  const key = async (by: number, contentRows = 15, bodyRows = 16) => {
    await $.ui.scroll({ ...SCROLL, by, bodyRows, contentRows });
    return current();
  };
  return { ui, engine, current, key };
}

test("on the board a page key moves the cursor by the tasks the window shows, Home and End go to the ends, and the wheel is left to the engine", async ($, on) => {
  const { ui, engine, current, key } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long");
  expect(await current()).toEqual(["task-1"]);

  expect(await key(16)).toEqual(["task-4"]);
  expect(await key(16)).toEqual(["task-8"]);
  expect(await key(-16)).toEqual(["task-4"]);
  expect(await key(15)).toEqual(["task-30"]);
  expect(await key(16)).toEqual(["task-30"]);
  expect(await key(-15)).toEqual(["task-1"]);
  expect(await key(-16)).toEqual(["task-1"]);
  expect(engine).toEqual([]);

  expect(await key(1)).toEqual(["task-1"]);
  expect(engine).toEqual([1]);
  await ui.unmount();
});

test("on the Sections list a page key moves the pointer by the rows the window shows, Home and End go to the ends, and the wheel is left to the engine", async ($, on) => {
  const { ui, engine, current, key } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long", DOCK, ["t"]);
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
  const inline: Size = { columns: 80, rows: 40, placement: "inline" };
  const { ui, current, key } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long", inline, ["t"]);
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

test("on a section's page and a task's page the scroll keys reach the engine, which scrolls the page", async ($, on) => {
  const { ui, engine, key } = await windowed($, on, { [`${POSIX.plans}/long.md`]: LONG }, "plan long", DOCK, ["task-1"]);
  for (const by of [16, 31, -16]) await key(by, 31);
  await ui.press({ key: "b" });
  await ui.press({ key: "t" });
  await ui.press({ key: "row-1" });
  for (const by of [16, 31, -31, -16, 1]) await key(by, 31);
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
const INLINE_TIER: Size = { columns: 200, rows: 50, placement: "dock" };
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
    expect(rows(await ui.drawn()).slice(3)).toEqual([
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
      "k: Run check  s: Start here  c: Copy  e: Evidence",
      "o: Open only  x: Failing  f: Find  t: Sections",
      "l: Plans",
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
    { text: "Parse the plan", color: "inactive" },
    { text: " PROVEN ", color: "inverseText", backgroundColor: "success", bold: true },
  ]);
  expect(await row(3)).toEqual([
    { text: "○ ", color: "text", bold: true },
    { text: "3" },
    { text: "Draw the board", color: "text", bold: true },
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
  expect((await row(3)).slice(0, 3)).toEqual([{ text: "○ " }, { text: "3" }, { text: "Draw the board", color: "text", bold: true }]);
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
  expect(rows(await ui.drawn()).slice(4, 12)).toEqual([
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
    "○ 3 Draw the board                                                          UNPROVEN ",
    "     Draw **rows** and chips.",
    "     $ just test-mod",
    "     hooks/plan.ts 15m",
    "     ! no run since its files changed",
    "⊘ 4 Wire the hotkeys                                            blocked by 3  PROVEN ",
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
  expect(await ui.find({ type: "Markdown", text: "Draw **rows** and chips." })).toBeDefined();
  expect(await ui.find({ type: "Markdown", text: "**Must NOT:** add an option." })).toBeDefined();
  expect((await ui.find({ type: "Code" }))?.props).toMatchObject({ source: "just test-mod", language: "bash" });
  expect(spans(detail).filter((span) => span.backgroundColor !== undefined)).toEqual([
    { text: " OPEN ", color: "inverseText", backgroundColor: "inactive", bold: true },
    { text: " UNPROVEN ", color: "inverseText", backgroundColor: "warning", bold: true },
    { text: " ✓ 2 ", color: "inverseText", backgroundColor: "success", bold: true },
  ]);
  const texts = spans(detail).map((span) => span.text);
  expect(texts.slice(texts.indexOf("hooks/plan.ts"), texts.indexOf("hooks/plan.ts") + 3)).toEqual(["hooks/plan.ts", " ".repeat(8), "changed 15m ago"]);
  expect(spans(detail).find((span) => span.text === "changed 15m ago")).toEqual({ text: "changed 15m ago", color: "warning" });
  await ui.unmount();
});

test("a file changed moments ago reads changed just now, never now ago", async ($, on) => {
  const { w } = boardWorld(on);
  w.files.set(`${ROOT}/hooks/plan.ts`, { text: "x", mtimeMs: NOW - 1000 });
  const ui = await mountBoard($, SPLIT);
  await ui.press({ key: "task-3" });
  const drawn = rows(await ui.drawn());
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
  expect(rows(await ui.drawn()).slice(3)).toEqual([
    "Ship the board3 / 5",
    "b: Board  p: Prev  n: Next  k: Run check",
    "s: Start here  c: Copy  e: Evidence",
    "─".repeat(51),
    "3. Draw the board",
    " OPEN   UNPROVEN ",
    " ",
    "Do",
    "",
    "",
    " ",
    "Done when",
    "",
    "",
    " ",
    "Depends",
    " ✓ 2 ",
    " ",
    "Files",
    "  hooks/plan.ts                     changed 15m ago",
    " ",
    "Evidence",
    "  ! No test, build or lint run since its files cha…",
    "  Last pass, before that change:",
    "  ✓ test just test-mod exit 0 · 30m ago",
    " ",
    "↑↓ scroll · esc close",
  ]);
  expect(await ui.find({ type: "Markdown", text: "`just test-mod` exits 0" })).toBeDefined();

  await ui.press({ key: "n" });
  const four = rows(await ui.drawn());
  expect(four.slice(four.indexOf("Files"))).toEqual([
    "Files",
    "  hooks/keys.ts                      changed 3h ago",
    "  hooks/gone.ts                           not found",
    " ",
    "Evidence",
    "  ✓ test just test-mod exit 0 · 30m ago",
    "  ✗ lint just lint exit 1 · 1h ago",
    "  ✓ test bun test src/parse.spec.ts exit 0 · 2h ago",
    " ",
    "↑↓ scroll · esc close",
  ]);
  expect(four).toContain(" BLOCKED   PROVEN ");
  expect(four).toContain(" ○ 3  blocked by 3");

  await ui.press({ key: "n" });
  const five = rows(await ui.drawn());
  expect(five.slice(five.indexOf("Evidence"))).toEqual(["Evidence", "  Lists no files, so no run can prove it.", " ", "↑↓ scroll · esc close"]);
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
  expect(rows(await ui.drawn()).slice(4, 10)).toEqual([
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
  expect(rows(await ui.drawn())[4]).toBe("Find: keys.ts 1 of 5");
  expect((await ui.find({ key: "task-4" }))?.props["autoFocus"]).toBe(true);

  await ui.press({ key: "f" });
  await ui.input({ key: "filter", text: "zzz" });
  expect(await ui.find({ type: "Text", text: "No task matches the filter." })).toBeDefined();
  expect((await ui.find({ key: "k" }))?.props["dimColor"]).toBe(true);
  await ui.unmount();
});

test("OMCA_ASCII draws the board, its chips and bars from the ASCII set", async ($, on) => {
  boardWorld(on, PASSING, { OMCA_ASCII: "1" });
  await $.command.run(run("plan", 80));
  await $.agent.spawn(SPAWN);
  const ui = await $.ui.mount(pane("terminal", PAGE));
  expect(rows(await ui.drawn()).slice(3)).toEqual([
    "Ship the board[FINAL] [#######====////....] 2/5 - / 1 blocked+ 3 proven - ! 1 unproven - x 0 failednext 3 Draw the board@ executor on 3",
    " ",
    "-- Milestone 1: Core -- [######] 2/2 --------------",
    "+ 1 Parse the plan                         [PROVEN]",
    "+ 2 Prove each task                        [PROVEN]",
    "-- Milestone 2: Board -- [......] 0/3 -------------",
    "~ 3 Draw the board            @ executor [UNPROVEN]",
    "/ 4 Wire the hotkeys          blocked by 3 [PROVEN]",
    "o 5 Write the docs                                 ",
    " ",
    "k: Run check  s: Start here  c: Copy  e: Evidence",
    "o: Open only  x: Failing  f: Find  t: Sections",
    "l: Plans",
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
  expect(rows(await ui.drawn()).slice(3)).toEqual(["Reading the plan…"]);
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
  expect((await ui.find({ type: "Code" }))?.props["source"]).toBe("GH_TOKEN=‹masked› just test-mod");
  await ui.press({ key: "k" });
  await ui.press({ key: "c" });
  expect(fills).toEqual(["Run `GH_TOKEN=‹masked› just test-mod` to check task 3, then record the result with evidence_log."]);
  expect(copies[0]).toContain("- Done when: `GH_TOKEN=‹masked› just test-mod` exits 0");
  expect(spans(await ui.drawn()).at(-1)).toEqual({ text: "Copied task 3 with 1 secret masked.", color: "success" });
  await ui.unmount();
});
