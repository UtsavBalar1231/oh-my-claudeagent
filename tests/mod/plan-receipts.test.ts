import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { BOULDER, LEDGER, PLUGIN, ROOT, SESSION, spreadRows, textOf, type World, world, write } from "./world.ts";

const PLAN = `${ROOT}/plans/widget.md`;
const SOURCE = `${ROOT}/src/a.ts`;
const CHANGED_AT = Date.UTC(2026, 9, 2, 11, 0, 0);
const RUN_AT = CHANGED_AT + 60_000;

const registry = JSON.stringify({
  plans: { widget: { active_plan: PLAN, started_at: "2026-10-02T10:00:00Z", session_ids: [SESSION] } },
  bindings: { [SESSION]: { plan_name: "widget", bound_at: 1 } },
});

const planText = (done: number, total: number) =>
  `# Widget\n\n## TODOs\n\n${Array.from({ length: total }, (_, i) => `- [${i < done ? "x" : " "}] ${i + 1}. Port module ${i + 1}\n  - File: \`src/a.ts\``).join("\n")}\n`;

const run = (type: string, exitCode: number, command = "just test") => ({
  type,
  command,
  exit_code: exitCode,
  output_snippet: "",
  timestamp: new Date(RUN_AT).toISOString(),
});

const ledger = (...entries: readonly object[]) => JSON.stringify({ entries });

function setup(on: On, done: number, total: number, env: Readonly<Record<string, string>> = {}): World {
  const w = world(on, { [BOULDER]: registry, [PLAN]: planText(done, total) }, {}, env);
  w.files.set(SOURCE, { text: "a", mtimeMs: CHANGED_AT });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("ui.notify", () => ({ value: { isSent: true, channel: "kitty" } }));
  return w;
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });

const mainTurn = ($: Engine) => $.turn.complete({ answer: "done", durationMs: 1, isAborted: false, turnId: "t-main", reason: "answer" });

const agentTurn = ($: Engine) => $.turn.complete({ answer: "done", durationMs: 1, isAborted: false, turnId: "t-sub", reason: "answer", agentId: "a-1" });

async function rowsOf($: Engine, id: string, columns = 120): Promise<string[]> {
  const mounted = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", component: "Placed", requestId: `placed-${id}`, viewport: { columns, rows: 40 }, props: { id, plugin: PLUGIN } });
  const rows = spreadRows(await mounted.drawn());
  await mounted.unmount();
  return rows;
}

const finish = (w: World, done: number, total: number) => write(w, PLAN, planText(done, total));

test("work already done when the session starts places no row, and a task finished after it does", async ($, on) => {
  const w = setup(on, 2, 5);
  await start($);
  await mainTurn($);
  expect(w.placed).toEqual([]);

  finish(w, 3, 5);
  await mainTurn($);
  expect(w.placed).toHaveLength(1);
  expect(await rowsOf($, w.placed[0] ?? "")).toEqual(["! Task 3 Port module 3 · unproven"]);

  await mainTurn($);
  expect(w.placed).toHaveLength(1);
});

test("a plan bound mid-session counts its finished tasks as past work", async ($, on) => {
  const w = setup(on, 0, 3);
  w.files.delete(BOULDER);
  await start($);
  await mainTurn($);

  w.files.set(BOULDER, { text: registry, mtimeMs: CHANGED_AT });
  finish(w, 2, 3);
  await mainTurn($);
  expect(w.placed).toEqual([]);

  finish(w, 3, 3);
  await mainTurn($);
  expect(w.placed).toHaveLength(1);
});

test("a subagent's turn places nothing: its row would land among the main turn's tool rows, so the next main turn carries it", async ($, on) => {
  const w = setup(on, 0, 2);
  await start($);
  finish(w, 1, 2);
  await agentTurn($);
  expect(w.placed).toEqual([]);

  await mainTurn($);
  expect(w.placed).toHaveLength(1);
  expect(await rowsOf($, w.placed[0] ?? "")).toEqual(["! Task 1 Port module 1 · unproven"]);
});

test("the tasks one turn finishes share one row, each with its own verdict and the command that gave it", async ($, on) => {
  const w = setup(on, 0, 3);
  w.files.set(LEDGER, { text: ledger(run("test", 0)), mtimeMs: RUN_AT });
  await start($);
  finish(w, 2, 3);
  await mainTurn($);
  expect(w.placed).toHaveLength(1);
  expect(await rowsOf($, w.placed[0] ?? "")).toEqual(["✓ Task 1 Port module 1 · proven by just test", "✓ Task 2 Port module 2 · proven by just test"]);
});

test("evidence that lands after the turn corrects the row it already placed, with no second row", async ($, on) => {
  const w = setup(on, 0, 2);
  await start($);
  finish(w, 1, 2);
  await mainTurn($);
  const id = w.placed[0] ?? "";
  expect(await rowsOf($, id)).toEqual(["! Task 1 Port module 1 · unproven"]);

  w.files.set(LEDGER, { text: ledger(run("test", 1, "bun test")), mtimeMs: RUN_AT });
  await mainTurn($);
  expect(await rowsOf($, id)).toEqual(["✗ Task 1 Port module 1 · failed bun test"]);

  w.files.set(LEDGER, { text: ledger(run("test", 1, "bun test"), { ...run("test", 0), timestamp: new Date(RUN_AT + 1_000).toISOString() }), mtimeMs: RUN_AT + 1_000 });
  await mainTurn($);
  expect(await rowsOf($, id)).toEqual(["✓ Task 1 Port module 1 · proven by just test"]);
  expect(w.placed).toHaveLength(1);
});

test("a later task's edit to a shared file takes no proof back from a row, and no write redraws the rows", async ($, on) => {
  const w = setup(on, 0, 2);
  w.files.set(LEDGER, { text: ledger(run("test", 0)), mtimeMs: RUN_AT });
  let writes = 0;
  on("state.set", { key: "receipts" }, (_$, e, next) => ((writes += 1), next(e)));
  await start($);
  finish(w, 1, 2);
  await mainTurn($);
  const id = w.placed[0] ?? "";
  expect(await rowsOf($, id)).toEqual(["✓ Task 1 Port module 1 · proven by just test"]);
  expect(writes).toBe(1);

  w.files.set(SOURCE, { text: "edited for task 2", mtimeMs: RUN_AT + 60_000 });
  await mainTurn($);
  expect(await rowsOf($, id)).toEqual(["✓ Task 1 Port module 1 · proven by just test"]);
  expect(writes).toBe(1);
});

test("a final verification that passed stays passed in the row once the plan's files change again", async ($, on) => {
  const w = setup(on, 1, 2);
  w.files.set(LEDGER, { text: ledger(run("test", 0), run("final_verification", 0, "just ci")), mtimeMs: RUN_AT });
  await start($);
  finish(w, 2, 2);
  await mainTurn($);
  const id = w.placed[0] ?? "";
  const passed = "✓ Plan widget complete · 2/2 · ✓ 2 proven · final verification passed";
  expect((await rowsOf($, id))[1]).toBe(passed);

  w.files.set(SOURCE, { text: "edited after", mtimeMs: RUN_AT + 60_000 });
  w.files.set(LEDGER, { text: ledger(run("test", 0)), mtimeMs: RUN_AT + 60_000 });
  await mainTurn($);
  expect((await rowsOf($, id))[1]).toBe(passed);
});

test("on a surface that reports no width and clips its own rows, a long title is not cut to fit", async ($, on) => {
  const w = setup(on, 0, 2);
  const long = "Port the snapshot, the ledger, the gate, the fixture and the window onto the shared router and tracker";
  write(w, PLAN, planText(0, 2).replace("Port module 1", long));
  await start($);
  write(w, PLAN, planText(1, 2).replace("Port module 1", long));
  await mainTurn($);
  const mounted = await $.ui.mount({ plugin: PLUGIN, surface: "desktop", component: "Placed", requestId: "placed", props: { id: w.placed[0] ?? "", plugin: PLUGIN } });
  expect(textOf(await mounted.drawn())).toContain(long);
  await mounted.unmount();
});

test("a turn that changes no verdict writes no state, since every placed row redraws on a write", async ($, on) => {
  const w = setup(on, 0, 2);
  let writes = 0;
  on("state.set", { key: "receipts" }, (_$, e, next) => ((writes += 1), next(e)));
  await start($);
  finish(w, 1, 2);
  await mainTurn($);
  expect(writes).toBe(1);

  await mainTurn($);
  await mainTurn($);
  expect(writes).toBe(1);
});

test("the turn that ends a plan adds its outcome, and a final verification logged later turns it to passed", async ($, on) => {
  const w = setup(on, 1, 2);
  w.files.set(LEDGER, { text: ledger(run("test", 0)), mtimeMs: RUN_AT });
  await start($);
  finish(w, 2, 2);
  await mainTurn($);
  const id = w.placed[0] ?? "";
  expect(await rowsOf($, id)).toEqual([
    "✓ Task 2 Port module 2 · proven by just test",
    "! Plan widget complete · 2/2 · ✓ 2 proven · final verification not logged",
  ]);

  w.files.set(LEDGER, { text: ledger(run("test", 0), run("final_verification", 0, "just ci")), mtimeMs: RUN_AT + 1_000 });
  await mainTurn($);
  expect((await rowsOf($, id))[1]).toBe("✓ Plan widget complete · 2/2 · ✓ 2 proven · final verification passed");
  expect(w.toasts).toEqual([]);
});

test("a task finished beside a blocked one places its row and no plan outcome", async ($, on) => {
  const w = setup(on, 0, 2);
  write(w, PLAN, "- [ ] 1. a\n- [~] 2. b\n");
  await start($);
  write(w, PLAN, "- [x] 1. a\n- [~] 2. b\n");
  await mainTurn($);
  expect(w.placed).toHaveLength(1);
  expect(await rowsOf($, w.placed[0] ?? "")).toEqual(["✓ Task 1 a"]);
  expect(w.toasts).toEqual([]);
});

for (const [name, answer] of [
  ["rejects, as on a client with no placed rows", { rejects: "ui.place is not available" }],
  ["answers that no row stands", { isPlaced: false, reason: "past the cap" }],
] as const) {
  test(`a plan's end toasts where $.ui.place ${name}`, async ($, on) => {
    const w = setup(on, 1, 2);
    w.placeAnswer = answer;
    await start($);
    finish(w, 2, 2);
    await mainTurn($);
    expect(w.toasts).toEqual(["Plan complete: widget 2/2"]);
  });

  test(`a task that does not end the plan stays quiet where $.ui.place ${name}`, async ($, on) => {
    const w = setup(on, 0, 2);
    w.placeAnswer = answer;
    await start($);
    finish(w, 1, 2);
    await mainTurn($);
    expect(w.toasts).toEqual([]);
  });
}

test("a row waiting for a surface still stands, so a plan's end adds no toast", async ($, on) => {
  const w = setup(on, 1, 2);
  w.placeAnswer = { isPlaced: false, requestId: "waiting", reason: "no-surface" };
  await start($);
  finish(w, 2, 2);
  await mainTurn($);
  expect(w.placed).toHaveLength(1);
  expect(w.toasts).toEqual([]);
});

test("OMCA_DISABLED_HOOKS=plan-receipts places no row and keeps the toast off too", async ($, on) => {
  const w = setup(on, 1, 2, { OMCA_DISABLED_HOOKS: "plan-receipts" });
  await start($);
  finish(w, 2, 2);
  await mainTurn($);
  expect(w.placed).toEqual([]);
  expect(w.toasts).toEqual([]);
});

function seedReceipts(on: On, count: number): () => readonly { id: string }[] {
  let stored: unknown = Array.from({ length: count }, (_, i) => ({ id: `receipt-old-${i}`, plan: "other", path: "/other.md", total: 1, tasks: [], complete: null }));
  on("state.get", async (_$, e, next) => (e.key === "receipts" ? { value: { value: stored, version: 1 } } : next(e)));
  on("state.set", async (_$, e, next) => {
    if (e.key !== "receipts") return next(e);
    stored = e.value;
    return { value: { isSet: true, version: 2 } };
  });
  return () => stored as readonly { id: string }[];
}

test("every row that stands keeps its facts, however many there are", async ($, on) => {
  const w = setup(on, 0, 2);
  const kept = seedReceipts(on, 499);
  await start($);
  finish(w, 1, 2);
  await mainTurn($);
  expect(kept()).toHaveLength(500);
  expect(kept()[0]?.id).toBe("receipt-old-0");
  expect(kept()[499]?.id).toBe(w.placed[0]);
});

test("a row past the engine's 500 keeps no facts, so the rows that stand keep theirs and still draw", async ($, on) => {
  const w = setup(on, 0, 2);
  w.placeAnswer = { isPlaced: false, reason: "a plugin holds at most 500 placed rows" };
  const kept = seedReceipts(on, 500);
  await start($);
  finish(w, 1, 2);
  await mainTurn($);
  expect(w.placed).toHaveLength(1);
  expect(kept().map(({ id }) => id)).toEqual(Array.from({ length: 500 }, (_, i) => `receipt-old-${i}`));
  expect(w.toasts).toEqual([]);
});

test("a row OMCA did not place keeps what is beneath it", async ($, on) => {
  setup(on, 0, 1);
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ["beneath"] });
  });
  await start($);
  expect(await rowsOf($, "something-else")).toEqual(["beneath"]);
});
