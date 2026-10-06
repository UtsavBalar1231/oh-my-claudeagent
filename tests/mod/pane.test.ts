import type { On } from "claude-code";
import { type Engine, expect, type Plugin, test } from "claude-code/testing";
import { joinPath } from "../../src/core/path.ts";
import { usableColumns } from "../../src/core/ui-kit.ts";
import {
  bodyColumns,
  BOULDER,
  cellsAcross,
  drain,
  hold,
  isAscii,
  LAYOUTS,
  LEDGER,
  local,
  pane,
  POSIX,
  resettableState,
  ROOT,
  rows,
  run,
  SESSION,
  SIZES,
  topRows,
  usage,
  world,
  type World,
  write,
} from "./world.ts";

const TITLE = "Ship the sample widget service";
const PLAN_PATH = `${ROOT}/plans/sample.md`;
const NOTES = `${ROOT}/.omca/notepads/sample/learnings.md`;
const LONG_TITLE =
  "Rename every widget_id column reference in the export path, the import path and the nightly job so the title truncates";

function taskTitle(n: number): string {
  if (n === 7) return LONG_TITLE;
  if (n === 23) return "Render the 日本語 and 한국어 labels at full width";
  return `Port step ${n} onto the shared harness`;
}

// Pages: 0 overview, 1 TODOs and 2 Milestone 0 (headings without text), then each milestone
// heading and its ten tasks, so task n sits at n + 2 + (its milestone), 53 pages in all.
const PLAN = [
  `# ${TITLE}`,
  "",
  "A synthetic plan for the pane tests.",
  "",
  "## TODOs",
  ...Array.from({ length: 46 }, (_, i) => i + 1).flatMap((n) => [
    ...(n % 10 === 1 ? ["", `### Milestone ${(n - 1) / 10}`] : []),
    `- [${n <= 12 ? "x" : " "}] ${n}. ${taskTitle(n)}`,
    `  - Do: step ${n} in detail.`,
  ]),
].join("\n");

const pageOf = (n: number) => n + 2 + Math.floor((n - 1) / 10);

const ENTRIES = [
  ["build", "bun run build", 0, "2026-10-02T09:00:00Z"],
  ["lint", "just lint", 0, "2026-10-02T09:30:00Z"],
  ["test", "just test-mod", 1, "2026-10-02T10:00:00Z"],
  ["test", "just test-mod", 0, "2026-10-02T10:20:00Z"],
  ["final_verification", "just ci", 0, "2026-10-02T11:45:00Z"],
] as const;

const ledger = (entries: readonly (readonly [string, string, number, string])[]) =>
  JSON.stringify({
    entries: entries.map(([type, command, exit, timestamp]) => ({
      type,
      command,
      exit_code: exit,
      output_snippet: "ok",
      timestamp,
      verified_by: "executor",
    })),
  });

const FILES = {
  [PLAN_PATH]: PLAN,
  [BOULDER]: JSON.stringify({
    plans: { sample: { active_plan: PLAN_PATH, started_at: "2026-10-02T08:00:00Z" } },
    bindings: { [SESSION]: { plan_name: "sample" } },
  }),
  [LEDGER]: ledger(ENTRIES),
  [NOTES]: "- The ledger rotates at 1,000 entries.\n- Session ids come from the payload.",
};


const SPAWN = {
  tool_use_id: "toolu_1",
  prompt: "Fix the parser.",
  description: "Fix the parser",
  subagentType: "oh-my-claudeagent:executor",
  provider: { plugin: "oh-my-claudeagent", tier: "user" },
  parentModel: "claude-opus-5-5",
  background: false,
  fork: false,
} as const;

function agentEngine(on: Parameters<typeof world>[0]): void {
  on("agent.spawn", () => ({ model: "claude-sonnet-5-5", agentId: "a-1" }));
  on("turn.step", async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: usage(1200, 300) };
  });
  on("turn.complete", (_$, e) => ({ text: e.answer }));
}

// Another plugin's close reaches the pane's close feature with origin `plugin`; a test cannot
// raise the person's Esc, whose back-to-contents path the visual captures cover.
const CLOSER: Plugin = {
  name: "closer",
  register(on) {
    on("command.run", { command: "close-omca" }, async ($) => {
      await $.ui.close({ id: "omca" });
      return { text: "" };
    });
  },
};

const closeRun = {
  command: "close-omca",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: true, columns: 120 },
} as const;

test("/omca opens the pane focused and closable by Esc on the Agents tab, sized to the terminal", async ($, on) => {
  const w = world(on, FILES);

  expect(await $.command.run(run(""))).toEqual({});

  expect(w.opened).toEqual([{ id: "omca", title: "OMCA", focus: true, closeOnEscape: true, rows: 12, columns: 56 }]);
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  expect(rows(await ui.drawn())).toEqual([
    "1: Agents  2: Plan  3: Evidence  4: Notepad",
    "5: Feedback  6: Stats  7: Doctor",
    "─".repeat(51),
    "No subagent has run in this session yet.",
  ]);
  expect((await ui.find({ key: "1" }))?.props["dimColor"]).toBeUndefined();
  expect((await ui.find({ key: "2" }))?.props["dimColor"]).toBe(true);
  await ui.unmount();
});

test("each tab key shows its tab, on the terminal and the desktop", async ($, on) => {
  world(on, FILES);
  await $.command.run(run(""));
  const time = (iso: string) => local(iso).slice(6);

  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount(pane(surface, { columns: 120, rows: 40, placement: "dock" }));
    const body = async () => rows(await ui.drawn()).slice(3);

    await ui.press({ key: "2" });
    expect((await body()).slice(0, 2)).toEqual([
      `${TITLE}██████▎█████████████████ 12/46no task lists a file to provenext 13 Port step 13 onto the shared harness`,
      "  ↑ 4 more",
    ]);
    expect((await ui.find({ key: "2" }))?.props["dimColor"]).toBeUndefined();
    expect((await ui.find({ key: "1" }))?.props["dimColor"]).toBe(true);

    await ui.press({ key: "3" });
    expect(await ui.find({ type: "Text", text: " COMPLETE " })).toBeDefined();
    expect((await body()).filter((row) => /^[❯ ] [✓✗] {2}\d\d:\d\d /.test(row))).toEqual([
      `❯ ✓  ${time("2026-10-02T11:45:00Z")}  final   just ci`,
      `  ✓  ${time("2026-10-02T10:20:00Z")}  test    just test-mod`,
      `  ✗  ${time("2026-10-02T10:00:00Z")}  test    just test-mod`,
      `  ✓  ${time("2026-10-02T09:30:00Z")}  lint    just lint`,
      `  ✓  ${time("2026-10-02T09:00:00Z")}  build   bun run build`,
    ]);

    await ui.press({ key: "4" });
    expect((await body())[0]).toBe("sample  BOUND  · 1 entry");
    expect(await ui.find({ type: "Markdown", text: "- The ledger rotates at 1,000 entries.\n- Session ids come from the payload." })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "Learnings · 1 entry" })).toBeDefined();

    await ui.press({ key: "5" });
    expect(await body()).toEqual([
      "u: Up  d: Down  rate the session (no turn yet)",
      "No feedback has been recorded in this session.",
    ]);
    await ui.press({ key: "6" });
    expect(await body()).toEqual(["No delegation statistics have been collected yet.", "r: Reload"]);
    await ui.press({ key: "7" });
    expect(await body()).toEqual(["The doctor checks have not run in this session.", "r: Run checks"]);
    await ui.press({ key: "1" });
    expect(await body()).toEqual(["No subagent has run in this session yet."]);
    await ui.unmount();
  }
});

for (const layout of LAYOUTS) {
  const planPath = joinPath(layout.platform, layout.root, "plans", "sample.md");
  const spellings = layout === POSIX ? [planPath] : [planPath, planPath.replaceAll("/", "\\")];

  test(`/omca plan opens the Plan tab on the bound plan, a name in plansDirectory, or a path${layout === POSIX ? "" : ` (${layout.name})`}`, async ($, on) => {
    const bound = { plans: { sample: { active_plan: planPath } }, bindings: { [SESSION]: { plan_name: "sample" } } };
    const w = world(on, { [planPath]: PLAN, [layout.boulder]: JSON.stringify(bound) }, { plansDirectory: "./plans" }, {}, layout);
    const wanted: (readonly [string, string])[] = [
      ["plan", planPath],
      ["plan sample", planPath],
      ["plan plans/sample.md", planPath],
      ...spellings.map((spelling): readonly [string, string] => [`plan ${spelling}`, spelling]),
    ];

    for (const [args, shown] of wanted) {
      w.opened.length = 0;
      expect(await $.command.run(run(args))).toEqual({});
      expect(w.opened).toEqual([{ id: "omca", title: "OMCA", focus: true, closeOnEscape: true, rows: 12, columns: 56 }]);
      const ui = await $.ui.mount(pane("terminal"));
      expect((await ui.find({ key: "task-13" }))?.props["autoFocus"], args).toBe(true);
      await ui.press({ key: "t" });
      expect(await ui.find({ type: "Text", text: `12/46 tasks done · ${shown}` }), args).toBeDefined();
      expect((await ui.find({ key: `row-${pageOf(13)}` }))?.props["autoFocus"]).toBe(true);
      await ui.unmount();
    }
  });
}

test("n, p and t page through the plan, and t returns to the row the pages came from", async ($, on) => {
  const w = world(on, FILES);
  await $.command.run(run("plan"));
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  const page = async () => rows(await ui.drawn()).slice(3, 7);

  await ui.press({ key: "t" });
  await w.clock.settle();
  const logged = w.logs.length;
  await ui.press({ key: `row-${pageOf(13)}` });
  await w.clock.settle();
  expect(await page()).toEqual([
    `${TITLE}14 / 47`,
    "t: Contents  p: Prev  n: Next  r: Reload",
    "─".repeat(51),
    "[ ] 13. Port step 13 onto the shared harness",
  ]);
  expect(await ui.find({ key: `md-${pageOf(13)}-0`, text: "- Do: step 13 in detail." })).toBeDefined();
  expect(rows(await ui.drawn())).toContain("next: [ ] 14. Port step 14 onto the shared harness");
  expect(w.logs.slice(logged)).toEqual([]);

  await ui.press({ key: "n" });
  await ui.press({ key: "n" });
  expect((await page())[3]).toBe("[ ] 15. Port step 15 onto the shared harness");
  expect((await page())[0]).toBe(`${TITLE}16 / 47`);
  await ui.press({ key: "p" });
  expect((await page())[3]).toBe("[ ] 14. Port step 14 onto the shared harness");

  await ui.press({ key: "t" });
  await w.clock.settle();
  expect((await ui.find({ key: `row-${pageOf(14)}` }))?.props["autoFocus"]).toBe(true);
  expect((await ui.find({ key: `row-${pageOf(13)}` }))?.props["autoFocus"]).toBeUndefined();
  // The test kit cannot resolve a plugin's own $.ui.focus, so the refocus shows as its refusal.
  expect(w.logs.at(-1)).toBe(`omca plan could not focus row-${pageOf(14)}: no implementation for ui.focus`);
  await ui.unmount();
});

test("a page names the task after it, and the last page names none", async ($, on) => {
  world(on, FILES);
  await $.command.run(run("plan"));
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  const next = async () => rows(await ui.drawn()).filter((row) => row.startsWith("next: "));

  await ui.press({ key: "t" });
  await ui.press({ key: `row-${pageOf(13)}` });
  expect(await next()).toEqual(["next: [ ] 14. Port step 14 onto the shared harness"]);
  await ui.press({ key: "p" });
  expect(await next()).toEqual(["next: [ ] 13. Port step 13 onto the shared harness"]);
  for (let presses = 0; presses < 40; presses += 1) await ui.press({ key: "n" });
  expect(await ui.find({ type: "Text", text: "[ ] 46. Port step 46 onto the shared harness" })).toBeDefined();
  expect(await next()).toEqual([]);
  await ui.unmount();
});

test("a plan picked while the timer is still reading the bound plan stays shown", async ($, on) => {
  const other = `${ROOT}/plans/other.md`;
  const w = world(on, { ...FILES, [other]: "# Another plan\n\n## TODOs\n\n- [ ] 1. Only task\n" }, { plansDirectory: "./plans" });
  await $.command.run(run("plan"));
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  await ui.press({ key: "l" });
  const pick = (await ui.findAll({ type: "Button" })).find((button) => button.props["label"] === "other")?.key ?? "";
  expect(pick).toStartWith("pick-");

  write(w, PLAN_PATH, `${PLAN}\n- [ ] 47. Added after the pane loaded it`);
  const release = hold(w, PLAN_PATH);
  const ticking = w.clock.advance(2000);
  await w.clock.settle();
  const pressing = ui.press({ key: pick });
  await w.clock.settle();
  release();
  await Promise.all([ticking, pressing]);
  await w.clock.settle();

  expect(await ui.find({ type: "Text", text: "Another plan" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: TITLE })).toBeUndefined();
  await ui.unmount();
});

test("a plan picked wins even when the timer's write lands while the pick is still reading", async ($, on) => {
  const other = `${ROOT}/plans/other.md`;
  const w = world(on, { ...FILES, [other]: "# Another plan\n\n## TODOs\n\n- [ ] 1. Only task\n" }, { plansDirectory: "./plans" });
  await $.command.run(run("plan"));
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  await ui.press({ key: "l" });
  const pick = (await ui.findAll({ type: "Button" })).find((button) => button.props["label"] === "other")?.key ?? "";
  expect(pick).toStartWith("pick-");

  const release = hold(w, other);
  const pressing = ui.press({ key: pick });
  await w.clock.settle();
  write(w, PLAN_PATH, `${PLAN}\n- [ ] 47. Added after the pane loaded it`);
  const readsOfBound = () => w.reads.filter((path) => path === PLAN_PATH).length;
  const before = readsOfBound();
  await w.clock.advance(2000);
  expect(readsOfBound()).toBeGreaterThan(before);
  release();
  await pressing;
  await w.clock.settle();

  expect(await ui.find({ type: "Text", text: "Another plan" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: TITLE })).toBeUndefined();
  await ui.unmount();
});

test("the Evidence and Notepad tabs load again after the session state is reset", async ($, on) => {
  const atoms = resettableState(on);
  const w = world(on, FILES);
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  const first = async (key: string) => {
    await ui.press({ key });
    await ui.redraw();
    return rows(await ui.drawn())[3];
  };
  expect(await first("3")).toStartWith("Final verification · sample COMPLETE");
  expect(await first("4")).toBe("sample  BOUND  · 1 entry");

  atoms.reset("pane");
  atoms.reset("ledger");
  await w.clock.advance(2000);

  expect(await first("3")).toStartWith("Final verification · sample COMPLETE");
  expect(await first("4")).toBe("sample  BOUND  · 1 entry");
  await ui.unmount();
});

test("the contents list fills the inline body and a focus move re-centres it on the ring's position", async ($, on) => {
  const w = world(on, FILES);
  await $.command.run(run("plan", 80));
  const ui = await $.ui.mount(pane("terminal", { columns: 80, rows: 40, placement: "inline" }));
  const task = (n: number, mark = n <= 12 ? "x" : " ") => `      [${mark}] ${n}. Port step ${n} onto the shared harness`;
  await ui.press({ key: "t" });

  expect(rows(await ui.drawn())).toEqual([
    "1: Agents 2: Plan 3: Evidence 4: Notepad 5: Feedback 6: Stats 7: Doctor",
    `${TITLE} · 12/46 tasks done`,
    "  ↑ 13 more",
    "    Milestone 1",
    task(11),
    task(12),
    `❯${task(13).slice(1)}`,
    task(14),
    task(15),
    "  ↓ 34 more",
    "b: Board   r: Reload   l: Plans   ↑↓ move · enter open · esc close",
  ]);

  await $.ui.focus({ component: "Pane", requestId: "omca", element: `row-${pageOf(14)}`, origin: { kind: "person" } });
  expect(w.focused.at(-1)).toBe(`row-${pageOf(14)}`);
  expect(rows(await ui.drawn()).slice(2, 10)).toEqual([
    "  ↑ 14 more",
    task(11),
    task(12),
    task(13),
    `❯${task(14).slice(1)}`,
    task(15),
    task(16),
    "  ↓ 33 more",
  ]);

  await $.ui.focus({ component: "Pane", requestId: "omca", element: `row-${pageOf(15)}`, origin: { kind: "person" } });
  expect(w.focused.at(-1)).toBe(`row-${pageOf(14)}`);
  expect(rows(await ui.drawn()).slice(2, 10)).toEqual([
    "  ↑ 15 more",
    task(12),
    task(13),
    task(14),
    `❯${task(15).slice(1)}`,
    task(16),
    task(17),
    "  ↓ 32 more",
  ]);
  await ui.unmount();
});

test("an agent row appears on agent.spawn, sums its steps and ends on turn.complete", async ($, on) => {
  const w = world(on, FILES);
  agentEngine(on);
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  const lane = async (key: string) => (await ui.find({ key }))?.text;

  await $.agent.spawn(SPAWN);
  w.agents = [{ id: "a-1", description: "Fix the parser", type: "oh-my-claudeagent:executor", status: "running" }];
  expect(await ui.find({ type: "Text", text: "1 running · 0 finished · 0 tokens" })).toBeDefined();
  expect(await lane("lane-a-1")).toBe("◆ executor · Fix the parser      sonnet-5-5      0s");
  expect(await lane("tools-a-1")).toBe("  · starting");

  await drain($.turn.step({ turnId: "t-1", index: 0, model: "claude-sonnet-5-5", effort: "high", messageCount: 1, agentId: "a-1" }));
  await w.clock.advance(66_000);
  expect(await lane("lane-a-1")).toBe("◆ executor · Fix the parser            high   1m06s");

  await $.turn.complete({
    answer: "done",
    durationMs: 66_000,
    isAborted: false,
    turnId: "t-1",
    reason: "answer",
    agentId: "a-1",
    usage: usage(2000, 500),
  });
  await w.clock.advance(4000);
  expect(await ui.find({ type: "Text", text: "0 running · 1 finished · 2.5k tokens" })).toBeDefined();
  expect(await lane("done-a-1")).toBe("✓ executor · done                             1m06s");
  expect(await lane("lane-a-1")).toBeUndefined();
  await ui.unmount();
});

test("the pane timer ends a row the agent list no longer holds and picks up new evidence, until the pane closes", { plugins: [CLOSER] }, async ($, on) => {
  const w: World = world(on, FILES);
  agentEngine(on);
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", { columns: 200, rows: 50, placement: "dock" }));
  await $.agent.spawn(SPAWN);
  w.agents = [{ id: "a-1", description: "Fix the parser", type: "oh-my-claudeagent:executor", status: "running" }];

  await w.clock.advance(2000);
  expect(await ui.find({ type: "Text", text: "1 running · 0 finished · 0 tokens" })).toBeDefined();

  w.agents = [];
  write(w, LEDGER, ledger([...ENTRIES, ["test", "just test", 0, "2026-10-02T12:00:00Z"]]));
  await w.clock.advance(2000);
  expect(await ui.find({ type: "Text", text: "0 running · 1 finished · 0 tokens" })).toBeDefined();
  expect((await ui.find({ key: "done-a-1" }))?.text).toStartWith("○ executor · ended");
  await ui.press({ key: "3" });
  expect(await ui.find({ type: "Text", text: "1/6 · ↑↓ move" })).toBeDefined();

  await $.command.run(closeRun);
  const reads = w.reads.length;
  write(w, LEDGER, ledger(ENTRIES));
  await w.clock.advance(6000);
  expect(w.reads.length).toBe(reads);
  await ui.unmount();
});

test("a session that starts with the pane already open restarts its refresh timer", async ($, on) => {
  const w = world(on, { ...FILES, [LEDGER]: ledger([...ENTRIES, ["test", "just test", 0, "2026-10-02T12:00:00Z"]]) });
  w.panes = [{ id: "omca", title: "OMCA", isShown: true, isFocused: false, isPlaced: true }];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  await $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
  const ui = await $.ui.mount(pane("terminal", { columns: 200, rows: 50, placement: "dock" }));
  await ui.press({ key: "3" });
  expect(await ui.find({ type: "Text", text: "Reading the evidence ledger…" })).toBeDefined();

  await w.clock.advance(2000);
  expect(await ui.find({ type: "Text", text: "1/6 · ↑↓ move" })).toBeDefined();
  await ui.unmount();
});

test("a tab that fails to draw shows why in its place, and the tab row stays", async ($, on) => {
  const atoms = new Map<string, { value: unknown; version: number }>();
  on("state.get", (_$, e) => (e.key === "lanes" ? { deny: "lanes unreadable" } : { value: atoms.get(e.key) ?? { value: undefined, version: 0 } }));
  on("state.set", (_$, e) => {
    const version = (atoms.get(e.key)?.version ?? 0) + 1;
    atoms.set(e.key, { value: e.value, version });
    return { value: { isSet: true, version } };
  });
  world(on, FILES);
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  expect(rows(await ui.drawn())).toEqual(["1: Agents  2: Plan  3: Evidence  4: Notepad", "5: Feedback  6: Stats  7: Doctor", "─".repeat(51), "✗ The agents tab failed: lanes unreadable"]);
  await ui.unmount();
});

test("drawing the pane reads, stats and lists nothing, whatever the tab, size or surface", async ($, on) => {
  const w = world(on, FILES);
  agentEngine(on);
  await $.command.run(run(""));
  await $.agent.spawn(SPAWN);
  w.reads.length = 0;

  for (const size of SIZES) {
    for (const surface of ["terminal", "desktop"] as const) {
      const ui = await $.ui.mount(pane(surface, size));
      expect(w.reads, `${size.columns} ${size.placement} ${surface} mount`).toEqual([]);
      for (const key of ["2", "3", "4", "5", "6", "7", "1"]) {
        await ui.press({ key });
        w.reads.length = 0;
        await ui.redraw();
        expect(w.reads, `${size.columns} ${size.placement} ${surface} tab ${key}`).toEqual([]);
      }
      await ui.unmount();
    }
  }
});

test("every row stays inside the body less the close-mark gutter at 80, 120 and 200 columns, docked and inline", async ($, on) => {
  const w = world(on, FILES);
  agentEngine(on);
  await $.command.run(run(""));
  await $.agent.spawn({ ...SPAWN, description: "Rename every widget_id reference across the export and import paths" });
  write(w, LEDGER, ledger([...ENTRIES, ["manual", `bun scripts/qa/visual.ts ${"plan-reader ".repeat(12)}`, 0, "2026-10-02T12:00:00Z"]]));
  await w.clock.advance(2000);

  for (const size of SIZES) {
    for (const surface of ["terminal", "desktop"] as const) {
      const room = usableColumns(bodyColumns(size));
      const ui = await $.ui.mount(pane(surface, size));
      const views: string[] = [];
      for (const key of ["1", "2", "3", "4", "5", "6", "7"]) {
        await ui.press({ key });
        views.push(key);
        if (key === "2") {
          const fits = async (where: string) => {
            for (const child of topRows(await ui.drawn())) {
              expect(cellsAcross(child), `${size.columns} ${size.placement} ${where}`).toBeLessThanOrEqual(room);
            }
          };
          await fits("board");
          const row = (await ui.findAll({ type: "Button" })).find((button) => button.props["autoFocus"] === true);
          await ui.press({ key: row?.key ?? "" });
          const detail = { type: "Text", text: `7. ${LONG_TITLE}` } as const;
          for (let presses = 0; presses < 10 && (await ui.find(detail)) === undefined; presses += 1) {
            await ui.press({ key: "p" });
          }
          expect(await ui.find(detail)).toBeDefined();
          await fits("task detail");
          await ui.press({ key: "b" });
          await ui.press({ key: "t" });
          const current = (await ui.findAll({ type: "Button" })).find((button) => button.props["autoFocus"] === true);
          await ui.press({ key: current?.key ?? "" });
          const heading = { type: "Text", text: `[x] 7. ${LONG_TITLE}` } as const;
          for (let presses = 0; presses < 20 && (await ui.find(heading)) === undefined; presses += 1) {
            await ui.press({ key: "p" });
          }
          expect(await ui.find(heading)).toBeDefined();
          for (const child of topRows(await ui.drawn())) {
            expect(cellsAcross(child), `${size.columns} ${size.placement} page`).toBeLessThanOrEqual(room);
          }
          await ui.press({ key: "p" });
          expect(rows(await ui.drawn()).find((row) => row.startsWith("next: "))).toStartWith("next: [x] 7. Rename every widget_id");
          for (const child of topRows(await ui.drawn())) {
            expect(cellsAcross(child), `${size.columns} ${size.placement} page before the long title`).toBeLessThanOrEqual(room);
          }
          await ui.press({ key: "n" });
          await ui.press({ key: "t" });
          await fits("sections");
          await ui.press({ key: "b" });
        }
        for (const child of topRows(await ui.drawn())) {
          expect(cellsAcross(child), `${size.columns} ${size.placement} tab ${key}`).toBeLessThanOrEqual(room);
        }
      }
      expect(views).toHaveLength(7);
      await ui.unmount();
    }
  }
});

test("OMCA_GLYPHS=ascii draws every glyph from the ASCII set", async ($, on) => {
  world(on, FILES, {}, { OMCA_GLYPHS: "ascii" });
  agentEngine(on);
  await $.command.run(run("plan", 80));
  await $.agent.spawn(SPAWN);
  const ui = await $.ui.mount(pane("terminal", { columns: 80, rows: 40, placement: "inline" }));

  const drawn = rows(await ui.drawn());
  expect(drawn.slice(1, 4)).toEqual([
    "Ship the s... [##......] 12/46 no task lists a file to prove  @ 1 running",
    "  ^ 12 more",
    "+ 11 Port step 11 onto the shared harness                                ",
  ]);
  expect(drawn.at(-1)).toBe("x: Failing  f: Find  t: Sections  l: Plans");
  await ui.press({ key: "1" });
  expect((await ui.find({ key: "lane-a-1" }))?.text).toStartWith("@ executor - Fix the parser");
  expect(rows(await ui.drawn()).filter((row) => !isAscii(row))).toEqual([]);
  await ui.unmount();
});

test("by default every tab draws Nerd Font glyphs, each one before a space or at a row's end", async ($, on) => {
  const w = world(on, FILES, {}, { OMCA_GLYPHS: "" });
  agentEngine(on);
  await $.command.run(run(""));
  await $.agent.spawn(SPAWN);
  w.agents = [{ id: "a-1", description: "Fix the parser", type: "oh-my-claudeagent:executor", status: "running" }];
  const ui = await $.ui.mount(pane("terminal", { columns: 200, rows: 50, placement: "dock" }));
  const glued: string[] = [];
  let icons = 0;
  for (const key of ["1", "2", "3", "4", "5", "6", "7"]) {
    await ui.press({ key });
    for (const row of rows(await ui.drawn())) {
      icons += [...row.matchAll(/[\u{e000}-\u{f8ff}]/gu)].length;
      glued.push(...[...row.matchAll(/[\u{e000}-\u{f8ff}](?=\S)/gu)].map(() => `${key}: ${row}`));
    }
  }
  expect(icons).toBeGreaterThan(0);
  expect(glued).toEqual([]);
  await ui.unmount();
});

const RUNNING = {
  tool_use_id: "toolu_1",
  prompt: "Fix the heading parser.",
  description: "Fix the heading parser",
  subagentType: "oh-my-claudeagent:executor",
  provider: { plugin: "oh-my-claudeagent", tier: "user" },
  parentModel: "claude-opus-5-5",
  background: true,
  fork: false,
} as const;

async function runningAgent($: Engine, on: On, surfaces: World["surfaces"]) {
  const w = world(on, FILES);
  w.surfaces = surfaces;
  on("agent.spawn", () => ({ model: "claude-sonnet-5-5", agentId: "a-1" }));
  await $.command.run(run(""));
  await $.agent.spawn(RUNNING);
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  return w;
}

test("with a terminal attached the timer redraws every second while the Agents tab shows a running agent", async ($, on) => {
  const w = await runningAgent($, on, ["terminal"]);
  const ui = await $.ui.mount(pane("terminal"));
  const before = w.invalidations;
  await w.clock.advance(5000);
  expect(w.invalidations - before).toBe(5);
  await ui.unmount();
});

for (const surfaces of [["desktop"], ["vscode"], []] as const) {
  test(`the timer never redraws over 5 seconds when surfaces is ${JSON.stringify(surfaces)}`, async ($, on) => {
    const w = await runningAgent($, on, [...surfaces]);
    const ui = await $.ui.mount(pane("terminal"));
    const before = w.invalidations;
    await w.clock.advance(5000);
    expect(w.invalidations).toBe(before);
    await ui.unmount();
  });
}

test("the timer stops redrawing when the Agents tab is left", async ($, on) => {
  const w = await runningAgent($, on, ["terminal"]);
  const ui = await $.ui.mount(pane("terminal"));
  await ui.press({ key: "2" });
  await w.clock.settle();
  const before = w.invalidations;
  await w.clock.advance(5000);
  expect(w.invalidations).toBe(before);
  await ui.unmount();
});

test("the timer reads the surfaces again on each tick", async ($, on) => {
  const w = await runningAgent($, on, ["desktop"]);
  const ui = await $.ui.mount(pane("terminal"));
  await w.clock.advance(3000);
  const before = w.invalidations;
  w.surfaces = ["desktop", "terminal"];
  await w.clock.advance(3000);
  expect(w.invalidations - before).toBe(3);
  await ui.unmount();
});
