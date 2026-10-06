import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { BOULDER, ROOT, run, SESSION, type World, world, write } from "./world.ts";

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

test("three agents finishing at different ticks give one toast when the last one ends", async ($, on) => {
  const w = setup(on);
  await spawn($, 1, "executor");
  await spawn($, 2, "explorer");
  await spawn($, 3, "architect");
  await finish($, "a-1");
  await finish($, "a-2");
  expect(w.toasts).toEqual([]);
  await finish($, "a-3", "error");
  expect(w.toasts).toEqual(["3 agents finished · 1 failed"]);
});

test("a lone agent is named, and the next wave starts from an empty tally", async ($, on) => {
  const w = setup(on);
  await spawn($, 1, "explorer");
  await finish($, "a-1");
  await spawn($, 2, "executor");
  await finish($, "a-2");
  expect(w.toasts).toEqual(["explorer finished", "executor finished"]);
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

test("a plan going from 13/14 to 14/14 toasts once", async ($, on) => {
  const w = setup(on, { [BOULDER]: registry, [PLAN]: planText(13, 14) });
  await start($);
  await mainTurn($);
  expect(w.toasts).toEqual([]);

  write(w, PLAN, planText(14, 14));
  await mainTurn($);
  await mainTurn($);
  expect(w.toasts).toEqual(["Plan complete: widget 14/14"]);
});

test("an idle teammate gives no toast", async ($, on) => {
  const w = setup(on);
  await spawn($, 1, "executor", true);
  await finish($, "a-1");
  expect(w.toasts).toEqual([]);
});

test("an agent the list reports killed joins the wave once, beside one that ended by its turn", async ($, on) => {
  const w = setup(on);
  await $.command.run(run(""));
  await spawn($, 1, "executor");
  await spawn($, 2, "explorer");
  w.agents = [
    { id: "a-1", description: "", type: "x", status: "running" },
    { id: "a-2", description: "", type: "x", status: "running" },
  ];
  await finish($, "a-1");
  expect(w.toasts).toEqual([]);
  w.agents = [
    { id: "a-1", description: "", type: "x", status: "completed" },
    { id: "a-2", description: "", type: "x", status: "killed" },
  ];
  await w.clock.advance(4000);
  expect(w.toasts).toEqual(["2 agents finished · 1 stopped"]);
});
