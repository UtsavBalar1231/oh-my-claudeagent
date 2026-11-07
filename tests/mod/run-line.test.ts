import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { displayWidth } from "../../src/core/ui-kit.ts";
import { PLUGIN, POSIX, spreadRows, textOf, world, write, type World } from "./world.ts";

const LIST = `${POSIX.home}/.claude/tasks/run-list`;
const RUN = "dotman-rewrite";

type Fields = { id: string; status?: string; metadata?: Record<string, unknown> };

const stored = ({ id, status = "pending", metadata = {} }: Fields) =>
  JSON.stringify({ id, subject: `Task ${id}`, description: "", activeForm: "", status, blocks: [], blockedBy: [], metadata: { run: RUN, ...metadata } });

const put = (w: World, ...tasks: readonly Fields[]) => {
  for (const task of tasks) write(w, `${LIST}/${task.id}.json`, stored(task));
};

// The seeded run: 1-5 done, 6 and 7 running, 8 closed as blocked, 9 pending, 10 final.
const SEEDED: readonly Fields[] = [
  ...[1, 2, 3, 4, 5].map((id) => ({ id: String(id), status: "completed" })),
  { id: "6", status: "in_progress" },
  { id: "7", status: "in_progress" },
  { id: "8", status: "in_progress", metadata: { blocked: "git 2.25 has no --porcelain=v2" } },
  { id: "9" },
  { id: "10", metadata: { final: true } },
];

type Placing = { placed: string[]; answer: { isPlaced: false; requestId?: string; reason: string } | undefined };

function setup(on: On, env: Readonly<Record<string, string>> = {}): { w: World; placing: Placing; fills: string[] } {
  const w = world(on, {}, {}, { CLAUDE_CODE_TASK_LIST_ID: "run-list", ...env });
  const placing: Placing = { placed: [], answer: undefined };
  const fills: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("prompt.fill", (_$, e) => (fills.push(e.text), { isFilled: true }));
  on("ui.render", ($, e) => $.ui.resolve(e).Text({ children: [`engine ${e.component}`] }));
  on("ui.place", (_$, e) => (placing.placed.push(e.id), { value: placing.answer ?? { isPlaced: true, requestId: `placed-${e.id}` } }));
  return { w, placing, fills };
}

const start = ($: Engine) => $.session.start({ cwd: POSIX.root, surface: "terminal", isInteractive: true });

async function turn($: Engine, work: () => void = () => {}, agentId?: string): Promise<void> {
  await $.turn.start({ text: "go", turnId: "t-1", ...(agentId !== undefined && { agentId }) });
  work();
  await $.turn.complete({ answer: "done", durationMs: 1, isAborted: false, turnId: "t-1", reason: "answer", ...(agentId !== undefined && { agentId }) });
}

async function rowOf($: Engine, id: string, columns = 120): Promise<string[]> {
  const mounted = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", component: "Placed", requestId: `placed-${id}`, viewport: { columns, rows: 40 }, props: { id, plugin: PLUGIN } });
  const rows = spreadRows(await mounted.drawn());
  await mounted.unmount();
  return rows;
}

const band = ($: Engine, bodyColumns = 120, view: { agentId?: string } = {}) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface: "terminal",
    component: "AbovePrompt",
    requestId: "band",
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 9 }, view },
  });

test("a turn that creates a run places one row under its turn line, naming what it created", async ($, on) => {
  const { w, placing } = setup(on);
  await start($);
  await turn($, () => put(w, ...[1, 2, 3, 4, 5].map((id) => ({ id: String(id) })), { id: "6", metadata: { final: true } }));

  expect(placing.placed).toHaveLength(1);
  expect(await rowOf($, placing.placed[0] ?? "")).toEqual(["◆ dotman-rewrite  0/6 · +6 tasks · /tasklist"]);
});

test("each turn's row names only what that turn changed, and a turn that changed nothing places none", async ($, on) => {
  const { w, placing } = setup(on);
  put(w, ...SEEDED);
  await start($);
  await turn($);
  expect(placing.placed).toEqual([]);

  await turn($, () => put(w, { id: "6", status: "completed" }, { id: "9", status: "in_progress" }));
  expect(await rowOf($, placing.placed[0] ?? "")).toEqual(["◆ dotman-rewrite  6/10 · ✓ #6 · ◐ #9 · /tasklist"]);

  await turn($, () => put(w, { id: "9", status: "in_progress", metadata: { blocked: "needs a decision" } }));
  expect(await rowOf($, placing.placed[1] ?? "")).toEqual(["◆ dotman-rewrite  6/10 · ⊗ #9 blocked · /tasklist"]);
  expect(await rowOf($, placing.placed[0] ?? "")).toEqual(["◆ dotman-rewrite  6/10 · ✓ #6 · ◐ #9 · /tasklist"]);
  expect(placing.placed).toHaveLength(2);
});

test("a subagent's turn places nothing", async ($, on) => {
  const { w, placing } = setup(on);
  put(w, ...SEEDED);
  await start($);
  await turn($, () => put(w, { id: "9", status: "in_progress" }), "agent-1");
  expect(placing.placed).toEqual([]);
});

test("the turn that completes the final task says final done", async ($, on) => {
  const { w, placing } = setup(on);
  put(w, ...SEEDED.map((task) => (task.id === "10" ? task : { id: task.id, status: "completed" })));
  await start($);
  await turn($, () => put(w, { id: "10", status: "completed", metadata: { final: true } }));
  expect(await rowOf($, placing.placed[0] ?? "")).toEqual(["◆ dotman-rewrite  10/10 · ◆ final done · /tasklist"]);
});

test("the row keeps every part at 200 columns and drops whole parts from the end as it narrows", async ($, on) => {
  const { w, placing } = setup(on);
  await start($);
  await turn($, () =>
    put(
      w,
      ...Array.from({ length: 26 }, (_, index) => ({ id: String(index + 1), status: index < 5 ? "completed" : index < 7 ? "in_progress" : "pending" })),
      { id: "8", status: "in_progress", metadata: { blocked: "no git" } },
      { id: "27", metadata: { final: true } },
    ),
  );
  const id = placing.placed[0] ?? "";
  expect(await rowOf($, id, 200)).toEqual(["◆ dotman-rewrite  5/27 · +27 tasks · ✓ #1 #2 #3 +2 · ◐ #6 #7 · ⊗ #8 blocked · /tasklist"]);
  const narrow = (await rowOf($, id, 80))[0] ?? "";
  expect(narrow).toBe("◆ dotman-rewrite  5/27 · +27 tasks · ✓ #1 #2 #3 +2 · ◐ #6 #7 · ⊗ #8 blocked");
  expect(await rowOf($, id, 60)).toEqual(["◆ dotman-rewrite  5/27 · +27 tasks · ✓ #1 #2 #3 +2"]);
  expect(displayWidth(narrow)).toBeLessThanOrEqual(80);
});

test("a row past the engine's cap does not stand and keeps no facts, and one waiting for a surface keeps them", async ($, on) => {
  const { w, placing } = setup(on);
  await start($);
  placing.answer = { isPlaced: false, reason: "a plugin holds at most 500 placed rows" };
  await turn($, () => put(w, { id: "1" }));
  expect(await rowOf($, placing.placed[0] ?? "")).toEqual(["engine Placed"]);

  placing.answer = { isPlaced: false, requestId: "later", reason: "no surface" };
  await turn($, () => put(w, { id: "2" }));
  expect(await rowOf($, placing.placed[1] ?? "")).toEqual(["◆ dotman-rewrite  0/2 · +1 task · /tasklist"]);
});

test("while a run is open the band shows its line and a button that fills the prompt with /tasklist", async ($, on) => {
  const { w, fills } = setup(on);
  put(w, ...SEEDED);
  await start($);
  await turn($);
  const mounted = await band($);
  const drawn = await mounted.drawn();
  expect(spreadRows(drawn)[0]).toBe("◆ dotman-rewrite ━━━━━━━━━━──── 5/10 · ◐ #6 #7 · ⊗ 1");
  expect((await mounted.findAll({ type: "Button" })).map((button) => textOf(button))).toEqual(["1: Task list"]);
  await mounted.press({ key: "task-list" });
  expect(fills).toEqual(["/tasklist"]);
  await mounted.unmount();

  const agent = await band($, 120, { agentId: "a1" });
  expect(spreadRows(await agent.drawn())[0]).toBe("◆ dotman-rewrite ━━━━━━━━━━──── 5/10 · ◐ #6 #7 · ⊗ 1");
  expect(await agent.findAll({ type: "Button" })).toEqual([]);
  await agent.unmount();

  const narrow = await band($, 31);
  expect(spreadRows(await narrow.drawn())[0]).toBe("◆ dotman-rewrite 5/10 · ⊗ 1");
  await narrow.unmount();
});

test("with no open run the band draws no run line and offers no task list", async ($, on) => {
  const { w } = setup(on);
  put(w, ...SEEDED.map((task) => ({ ...task, status: "completed", metadata: task.id === "10" ? { final: true } : {} })));
  await start($);
  await turn($);
  const mounted = await band($);
  expect(textOf(await mounted.drawn())).not.toContain(RUN);
  expect(await mounted.findAll({ type: "Button" })).toEqual([]);
  await mounted.unmount();
});

for (const [tier, line] of [
  ["ascii", "= dotman-rewrite ==========---- 5/10 - ~ #6 #7 - % 1"],
  ["nerd", "\u{f11e} dotman-rewrite ━━━━━━━━━━──── 5/10 · \u{f042} #6 #7 · \u{f05e} 1"],
] as const) {
  test(`the ${tier} tier draws the band line in its own marks`, async ($, on) => {
    const { w } = setup(on, { OMCA_GLYPHS: tier });
    put(w, ...SEEDED);
    await start($);
    const mounted = await band($);
    expect(spreadRows(await mounted.drawn())[0]).toBe(line);
    await mounted.unmount();
  });
}

test("showBand false hides the run line too", { options: { showBand: false } }, async ($, on) => {
  const { w } = setup(on);
  put(w, ...SEEDED);
  await start($);
  await turn($);
  const mounted = await band($);
  expect(textOf(await mounted.drawn())).not.toContain(RUN);
  await mounted.unmount();
});
