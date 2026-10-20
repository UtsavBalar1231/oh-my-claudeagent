import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { BOULDER, LEDGER, ROOT, run, SESSION, type World, world, write } from "./world.ts";

const STATUS = `${ROOT}/.omca/state/session/${SESSION}.json`;
const PLAN = `${ROOT}/plans/widget.md`;

const registry = JSON.stringify({
  plans: { widget: { active_plan: PLAN, started_at: "2026-10-02T10:00:00Z", session_ids: [SESSION] } },
  bindings: { [SESSION]: { plan_name: "widget", bound_at: 1 } },
});

const planText = (done: number, total: number) =>
  `# Widget\n\n## TODOs\n\n${Array.from({ length: total }, (_, i) => `- [${i < done ? "x" : " "}] ${i + 1}. Task ${i + 1}`).join("\n")}\n`;

const status = (at: number, exitCode: number) =>
  JSON.stringify({ session_id: SESSION, last_hook_at: at, verification: { command: "bun test", at, exit_code: exitCode, evidence_logged: false } });

function setup(on: On, files: Record<string, string> = {}): World {
  const w = world(on, files);
  let spawned = 0;
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("agent.spawn", () => ({ model: "claude-sonnet-5-5", agentId: `a-${++spawned}` }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  return w;
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });

const spawn = ($: Engine, n: number, type: string, isTeammate = false) =>
  $.agent.spawn({
    tool_use_id: `toolu_${n}`,
    prompt: "work",
    description: "work",
    subagentType: `oh-my-claudeagent:${type}`,
    provider: { plugin: "oh-my-claudeagent", tier: "user" },
    parentModel: "claude-opus-5-5",
    background: true,
    fork: false,
    ...(isTeammate && { isTeammate }),
  });

const finish = ($: Engine, agentId: string, reason: "answer" | "error" = "answer") =>
  $.turn.complete({ answer: "done", durationMs: 1, isAborted: false, turnId: `t-${agentId}`, reason, agentId });

const mainTurn = ($: Engine) =>
  $.turn.complete({ answer: "done", durationMs: 1, isAborted: false, turnId: "t-main", reason: "answer" });

test("finished agents raise no toast, by their own turn or by the agent list: the transcript reports each one", async ($, on) => {
  const w = setup(on);
  await $.command.run(run(""));
  await spawn($, 1, "executor");
  await spawn($, 2, "explorer");
  await spawn($, 3, "architect", true);
  await finish($, "a-1");
  await finish($, "a-3");
  w.agents = [{ id: "a-2", description: "", type: "x", status: "killed" }];
  await w.clock.advance(4000);
  expect(w.toasts).toEqual([]);
});

test("a nonzero verification toasts once, and one from before the session toasts never", async ($, on) => {
  const w = setup(on, { [STATUS]: status(1000, 1) });
  await start($);
  await mainTurn($);
  expect(w.toasts).toEqual([]);

  write(w, STATUS, status(2000, 1));
  await mainTurn($);
  await mainTurn($);
  expect(w.toasts).toEqual(["Verification failed: bun test (exit 1)"]);

  write(w, STATUS, status(3000, 0));
  await mainTurn($);
  expect(w.toasts).toHaveLength(1);
});

test("a subagent's turn reads no file while the registry, plan, ledger and status file keep their stamps, and still toasts a failed verification", async ($, on) => {
  const w = setup(on, { [BOULDER]: registry, [PLAN]: planText(3, 14), [STATUS]: status(1000, 0), [LEDGER]: JSON.stringify({ entries: [] }) });
  await start($);
  await mainTurn($);
  w.contentReads.length = 0;

  await finish($, "quiet-1");
  expect(w.contentReads).toEqual([]);

  write(w, STATUS, status(2000, 1));
  await finish($, "quiet-2");
  expect(w.toasts).toEqual(["Verification failed: bun test (exit 1)"]);
});

test("a plan going from 13/14 to 14/14 toasts once and raises one notification", async ($, on) => {
  const notified: unknown[] = [];
  on("ui.notify", (_$, e) => (notified.push(e), { value: { isSent: true, channel: "kitty" } }));
  const w = setup(on, { [BOULDER]: registry, [PLAN]: planText(13, 14) });
  await start($);
  await mainTurn($);
  expect(w.toasts).toEqual([]);

  write(w, PLAN, planText(14, 14));
  await mainTurn($);
  await mainTurn($);
  expect(w.toasts).toEqual(["Plan complete: widget 14/14"]);
  expect(notified).toEqual([{ text: "Plan complete: widget 14/14", title: "OMCA" }]);
});

test("an engine that raises no notification still toasts the plan's end and logs why", async ($, on) => {
  on("ui.notify", () => {
    throw new Error("no notification channel");
  });
  const w = setup(on, { [BOULDER]: registry, [PLAN]: planText(13, 14) });
  await start($);
  await mainTurn($);
  write(w, PLAN, planText(14, 14));
  await mainTurn($);
  expect(w.toasts).toEqual(["Plan complete: widget 14/14"]);
  expect(w.logs.some((line) => line.startsWith("band: notifying failed:"))).toBe(true);
});
