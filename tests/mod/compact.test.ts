import type { Args, On, SessionMessage } from "claude-code";
import { expect, test } from "claude-code/testing";
import { BOULDER, ROOT, SESSION, world } from "./world.ts";

type Compact = Args<"session.compact">;

const PLAN = `${ROOT}/plans/widget.md`;
const KEPT: SessionMessage = { role: "assistant", text: "the widget is half ported", toolUses: [] };

const registry = (sessionId: string) =>
  JSON.stringify({
    plans: { widget: { active_plan: PLAN, started_at: "2026-10-02T10:00:00Z", session_ids: [sessionId] } },
    bindings: { [sessionId]: { plan_name: "widget", bound_at: 1_789_990_000 } },
  });

const tasks = (done: number, total: number) =>
  `# Widget\n\n${Array.from({ length: total }, (_, i) => `- [${i < done ? "x" : " "}] ${i + 1}. Port module ${i + 1}`).join("\n")}\n`;

function engine(on: On, files: Record<string, string>, env: Record<string, string> = {}): Compact[] {
  world(on, files, {}, env);
  const seen: Compact[] = [];
  on("session.compact", (_$, e) => (seen.push(e), { messages: [KEPT] }));
  return seen;
}

const manual = (extra: Partial<Compact> = {}): Compact => ({ trigger: "manual", messages: [{ role: "user", text: "port the widget", toolUses: [] }, KEPT], ...extra });

test("compaction instructions name the bound plan and its open tasks", async ($, on) => {
  const seen = engine(on, { [BOULDER]: registry(SESSION), [PLAN]: tasks(1, 3) });
  await $.session.compact(manual());
  expect(seen.map((e) => e.instructions)).toEqual([
    `Keep OMCA's active plan in the summary: widget (${PLAN}).\nOpen tasks:\n- 2. Port module 2\n- 3. Port module 3`,
  ]);
});

test("the instructions typed after /compact come first, and the plan follows", async ($, on) => {
  const seen = engine(on, { [BOULDER]: registry(SESSION), [PLAN]: tasks(2, 3) });
  await $.session.compact(manual({ instructions: "focus on the parser" }));
  expect(seen.map((e) => e.instructions)).toEqual([
    `focus on the parser\n\nKeep OMCA's active plan in the summary: widget (${PLAN}).\nOpen tasks:\n- 3. Port module 3`,
  ]);
});

test("ten open tasks are listed and the rest are counted", async ($, on) => {
  const seen = engine(on, { [BOULDER]: registry(SESSION), [PLAN]: tasks(0, 12) });
  await $.session.compact(manual());
  const lines = (seen[0]?.instructions ?? "").split("\n");
  expect(lines.slice(2)).toEqual([...Array.from({ length: 10 }, (_, i) => `- ${i + 1}. Port module ${i + 1}`), "- and 2 more in the plan file"]);
});

test("a plan with every task checked says so", async ($, on) => {
  const seen = engine(on, { [BOULDER]: registry(SESSION), [PLAN]: tasks(3, 3) });
  await $.session.compact(manual());
  expect(seen.map((e) => e.instructions)).toEqual([`Keep OMCA's active plan in the summary: widget (${PLAN}).\nEvery numbered task is checked.`]);
});

test("a session bound to no plan keeps the instructions it was given", async ($, on) => {
  const seen = engine(on, { [BOULDER]: registry("someone-else"), [PLAN]: tasks(1, 3) });
  await $.session.compact(manual({ instructions: "keep" }));
  expect(seen.map((e) => e.instructions)).toEqual(["keep"]);
});

test("a bound plan whose file is gone leaves the instructions absent", async ($, on) => {
  const seen = engine(on, { [BOULDER]: registry(SESSION) });
  await $.session.compact(manual());
  expect(seen.map((e) => e.instructions)).toEqual([undefined]);
});

test("a subagent's compaction is left alone", async ($, on) => {
  const seen = engine(on, { [BOULDER]: registry(SESSION), [PLAN]: tasks(1, 3) });
  await $.session.compact(manual({ agentId: "a-1" }));
  expect(seen.map((e) => e.instructions)).toEqual([undefined]);
});

test("OMCA_DISABLED_HOOKS=compact leaves the instructions alone", async ($, on) => {
  const seen = engine(on, { [BOULDER]: registry(SESSION), [PLAN]: tasks(1, 3) }, { OMCA_DISABLED_HOOKS: "compact" });
  await $.session.compact(manual());
  expect(seen.map((e) => e.instructions)).toEqual([undefined]);
});
