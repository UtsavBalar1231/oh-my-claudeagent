import type { TurnUsage } from "claude-code";
import { expect, type Plugin, test } from "claude-code/testing";
import { joinPath } from "../../src/core/path.ts";
import { usableColumns } from "../../src/core/ui-kit.ts";
import {
  BOULDER,
  bodyColumns,
  cellsAcross,
  hold,
  LAYOUTS,
  LEDGER,
  pane,
  POSIX,
  resettableState,
  ROOT,
  rows,
  run,
  SESSION,
  SIZES,
  topRows,
  type World,
  world,
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

const two = (value: number) => String(value).padStart(2, "0");
const local = (iso: string) => {
  const date = new Date(iso);
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

const usage = (input: number, output: number): TurnUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: "claude-sonnet-5-5",
});

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

async function step(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
  for (let next = await stream.next(); next.done !== true; next = await stream.next());
}

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
  const newest = `✓ final   just ci                    0  ${local("2026-10-02T11:45:00Z")}`;
  const failed = `✗ test    just test-mod              1  ${local("2026-10-02T10:00:00Z")}`;

  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount(pane(surface, { columns: 120, rows: 40, placement: "dock" }));
    const body = async () => rows(await ui.drawn()).slice(3);

    await ui.press({ key: "2" });
    expect((await body()).slice(0, 2)).toEqual([TITLE, `12/46 tasks done · ${PLAN_PATH}`]);
    expect((await ui.find({ key: "2" }))?.props["dimColor"]).toBeUndefined();
    expect((await ui.find({ key: "1" }))?.props["dimColor"]).toBe(true);

    await ui.press({ key: "3" });
    expect(await body()).toEqual([
      "5 most recent entries, newest first",
      `  type    command                 exit  when       `,
      newest,
      `✓ test    just test-mod              0  ${local("2026-10-02T10:20:00Z")}`,
      failed,
      `✓ lint    just lint                  0  ${local("2026-10-02T09:30:00Z")}`,
      `✓ build   bun run build              0  ${local("2026-10-02T09:00:00Z")}`,
    ]);

    await ui.press({ key: "4" });
    expect((await body())[0]).toBe("Notepad for sample");
    expect(await ui.find({ type: "Markdown", text: "- The ledger rotates at 1,000 entries.\n- Session ids come from the payload." })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "Learnings" })).toBeDefined();

    await ui.press({ key: "5" });
    expect(await body()).toEqual([
      "u: Up  d: Down  rate the session (no turn yet)",
      "No feedback has been recorded in this session.",
    ]);
    await ui.press({ key: "6" });
    expect(await body()).toEqual(["No delegation statistics have been collected yet."]);
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

  await ui.press({ key: `row-${pageOf(13)}` });
  await w.clock.settle();
  expect(await page()).toEqual([
    `${TITLE}14 / 47`,
    "t: Contents  p: Prev  n: Next  r: Reload",
    "─".repeat(51),
    "[ ] 13. Port step 13 onto the shared harness",
  ]);
  expect(await ui.find({ key: `md-${pageOf(13)}-0`, text: "- Do: step 13 in detail." })).toBeDefined();
  expect(w.logs.at(-1)).toBe("omca plan could not refocus n: no implementation for ui.focus");

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
  expect(w.logs.at(-1)).toBe(`omca plan could not refocus row-${pageOf(14)}: no implementation for ui.focus`);
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
  expect(await first("3")).toBe("5 most recent entries, newest first");
  expect(await first("4")).toBe("Notepad for sample");

  atoms.reset("pane");
  await w.clock.advance(2000);

  expect(await first("3")).toBe("5 most recent entries, newest first");
  expect(await first("4")).toBe("Notepad for sample");
  await ui.unmount();
});

test("the contents list fills the inline body and a focus move re-centres it on the ring's position", async ($, on) => {
  const w = world(on, FILES);
  await $.command.run(run("plan", 80));
  const ui = await $.ui.mount(pane("terminal", { columns: 80, rows: 40, placement: "inline" }));
  const task = (n: number, mark = n <= 12 ? "x" : " ") => `      [${mark}] ${n}. Port step ${n} onto the shared harness`;

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
    "r: Reload   l: Plans   ↑↓ move · enter open · esc close",
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
  const body = async () => rows(await ui.drawn()).slice(3);

  await $.agent.spawn(SPAWN);
  w.agents = [{ id: "a-1", description: "Fix the parser", type: "oh-my-claudeagent:executor", status: "running" }];
  expect(await body()).toEqual([
    "1 running · 0 finished",
    "  agent        model         effort    time  tokens",
    "● executor     sonnet-5-5    ·           0s       0",
  ]);

  await step($.turn.step({ turnId: "t-1", index: 0, model: "claude-sonnet-5-5", effort: "high", messageCount: 1, agentId: "a-1" }));
  await w.clock.advance(66_000);
  expect((await body())[2]).toBe("● executor     sonnet-5-5    high     1m06s    1.5k");

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
  expect(await body()).toEqual([
    "0 running · 1 finished",
    "  agent        model         effort    time  tokens",
    "✓ executor     sonnet-5-5    high     1m06s    2.5k",
  ]);
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
  expect(await ui.find({ type: "Text", text: "1 running · 0 finished" })).toBeDefined();

  w.agents = [];
  write(w, LEDGER, ledger([...ENTRIES, ["test", "just test", 0, "2026-10-02T12:00:00Z"]]));
  await w.clock.advance(2000);
  expect(await ui.find({ type: "Text", text: "0 running · 1 finished" })).toBeDefined();
  expect((await ui.find({ key: "agent-a-1" }))?.text).toStartWith("○ executor · Fix the parser");
  await ui.press({ key: "3" });
  expect(await ui.find({ type: "Text", text: "6 most recent entries, newest first" })).toBeDefined();

  await $.command.run(closeRun);
  const reads = w.reads.length;
  write(w, LEDGER, ledger(ENTRIES));
  await w.clock.advance(6000);
  expect(w.reads.length).toBe(reads);
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
          await ui.press({ key: "t" });
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

test("OMCA_ASCII draws every glyph from the ASCII set", async ($, on) => {
  world(on, FILES, {}, { OMCA_ASCII: "1" });
  agentEngine(on);
  await $.command.run(run("plan", 80));
  await $.agent.spawn(SPAWN);
  const ui = await $.ui.mount(pane("terminal", { columns: 80, rows: 40, placement: "inline" }));

  const drawn = rows(await ui.drawn());
  expect(drawn[2]).toBe("  ^ 13 more");
  expect(drawn.find((row) => row.startsWith(">"))).toBe(">     [ ] 13. Port step 13 onto the shared harness");
  expect(drawn.at(-1)).toBe("r: Reload   l: Plans   ^v move - enter open - esc close");
  await ui.press({ key: "1" });
  expect(rows(await ui.drawn()).at(-1)).toStartWith("* executor - Fix the parser");
  const isAscii = (row: string) => [...row].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) < 127);
  expect(rows(await ui.drawn()).filter((row) => !isAscii(row))).toEqual([]);
  await ui.unmount();
});
