import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { PLUGIN, usage, world } from "./world.ts";

const OPTIONS = { title: "OMCA", key: "agents-done", delayMs: 60_000, untilBack: true };

type Sent = { text: string; title: string | undefined; key: string | undefined; delayMs: number | undefined; untilBack: boolean | undefined };

function engine(on: On, env: Record<string, string> = {}, version = "2.1.322", rejects = false) {
  const w = world(on, {}, {}, env);
  w.version = version;
  const sent: Sent[] = [];
  const cancelled: string[] = [];
  let spawned = 0;
  on("ui.notify", (_$, e) => {
    sent.push({ text: e.text, title: e.title, key: e.key, delayMs: e.delayMs, untilBack: e.untilBack });
    if (rejects) return { deny: "notifications are off" };
    return { value: { isSent: true, channel: "ghostty" } };
  });
  on("ui.cancelNotify", (_$, e) => (cancelled.push(e.key), { value: { isSent: true } }));
  on("agent.spawn", (_$, e) => ({ model: "claude-sonnet-5-5", agentId: e.resume?.agentId ?? `a-${++spawned}` }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  return { w, sent, cancelled };
}

const spawn = ($: Engine, n: number, type: string, description: string, extra: { isTeammate?: true; resume?: { agentId: string } } = {}) =>
  $.agent.spawn({
    tool_use_id: `toolu_${n}`,
    prompt: `Brief ${n}`,
    description,
    subagentType: `oh-my-claudeagent:${type}`,
    provider: { plugin: PLUGIN, tier: "user" },
    parentModel: "claude-opus-5-5",
    background: true,
    fork: false,
    ...extra,
  });

const finish = ($: Engine, agentId: string, reason: "answer" | "aborted" | "error" = "answer") =>
  $.turn.complete({ answer: "Done.", durationMs: 1000, isAborted: reason === "aborted", turnId: `t-${agentId}`, reason, agentId, usage: usage(2000, 500) });

test("one notification closes a wave, sent when the last of two agents finishes", async ($, on) => {
  const { sent } = engine(on);
  await spawn($, 1, "explorer", "Map the callers");
  await spawn($, 2, "executor", "Fix the parser");

  await finish($, "a-1");
  expect(sent).toEqual([]);
  await finish($, "a-2");
  expect(sent).toEqual([{ text: "2 agents finished · explorer, executor", ...OPTIONS }]);
});

test("a lone agent names its outcome and its task, and a failure says failed", async ($, on) => {
  const { sent } = engine(on);
  await spawn($, 1, "explorer", "Map the callers");
  await finish($, "a-1");
  await spawn($, 2, "executor", "Fix the parser");
  await finish($, "a-2", "error");
  await spawn($, 3, "architect", "Weigh the design");
  await finish($, "a-3", "aborted");

  expect(sent.map(({ text }) => text)).toEqual(["explorer finished · Map the callers", "executor failed · Fix the parser", "architect stopped · Weigh the design"]);
});

test("a wave with a failure leads with the counts", async ($, on) => {
  const { sent } = engine(on);
  await spawn($, 1, "explorer", "Map the callers");
  await spawn($, 2, "executor", "Fix the parser");
  await spawn($, 3, "architect", "Weigh the design");
  await finish($, "a-1");
  await finish($, "a-2", "error");
  await finish($, "a-3");

  expect(sent.map(({ text }) => text)).toEqual(["3 agents done, 1 failed · explorer, executor, architect"]);
});

test("a teammate joins no wave", async ($, on) => {
  const { sent, cancelled } = engine(on);
  await spawn($, 1, "explorer", "Scout", { isTeammate: true });
  expect(cancelled).toEqual([]);
  await finish($, "a-1");
  expect(sent).toEqual([]);

  await spawn($, 2, "executor", "Fix the parser");
  await finish($, "a-2");
  expect(sent.map(({ text }) => text)).toEqual(["executor finished · Fix the parser"]);
});

test("a resumed agent rejoins the wave and holds the notification until it ends again", async ($, on) => {
  const { sent } = engine(on);
  await spawn($, 1, "explorer", "Map the callers");
  await spawn($, 2, "executor", "Fix the parser");
  await finish($, "a-1");
  await spawn($, 3, "explorer", "Map the callers again", { resume: { agentId: "a-1" } });
  await finish($, "a-2");
  expect(sent).toEqual([]);

  await finish($, "a-1");
  expect(sent.map(({ text }) => text)).toEqual(["2 agents finished · explorer, executor"]);
});

test("the first spawn of each wave takes back a held notification, and a later spawn of the same wave does not", async ($, on) => {
  const { cancelled } = engine(on);
  await spawn($, 1, "explorer", "Map the callers");
  expect(cancelled).toEqual(["agents-done"]);
  await spawn($, 2, "executor", "Fix the parser");
  expect(cancelled).toEqual(["agents-done"]);

  await finish($, "a-1");
  await finish($, "a-2");
  await spawn($, 3, "architect", "Weigh the design");
  expect(cancelled).toEqual(["agents-done", "agents-done"]);
});

test("a client before 2.1.321 gets the title alone and no cancel", async ($, on) => {
  const { sent, cancelled } = engine(on, {}, "2.1.300");
  await spawn($, 1, "explorer", "Map the callers");
  await finish($, "a-1");

  expect(cancelled).toEqual([]);
  expect(sent).toEqual([{ text: "explorer finished · Map the callers", title: "OMCA", key: undefined, delayMs: undefined, untilBack: undefined }]);
});

test("OMCA_DISABLED_HOOKS=notify sends and cancels nothing", async ($, on) => {
  const { sent, cancelled } = engine(on, { OMCA_DISABLED_HOOKS: "notify" });
  await spawn($, 1, "explorer", "Map the callers");
  await finish($, "a-1");

  expect(sent).toEqual([]);
  expect(cancelled).toEqual([]);
});

test("a notification the engine refuses is logged and does not throw out of the hook", async ($, on) => {
  const { w, sent } = engine(on, {}, "2.1.322", true);
  await spawn($, 1, "explorer", "Map the callers");
  await finish($, "a-1");

  expect(sent).toHaveLength(1);
  expect(w.logs.some((line) => line.includes("notify: cannot send the notification"))).toBe(true);

  await spawn($, 2, "executor", "Fix the parser");
  await finish($, "a-2");
  expect(sent).toHaveLength(2);
});
