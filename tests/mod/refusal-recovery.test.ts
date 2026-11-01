import type { Args } from "claude-code";
import { type Engine, type EngineCall, expect, test } from "claude-code/testing";
import { world } from "./world.ts";

const start = (interactive = true) => ({ cwd: "/work", surface: "terminal" as const, isInteractive: interactive });
const prompt = (text: string, kind: "composer" | "bridge" | "sdk" | "plugin" = "composer") => ({
  text, origin: kind === "plugin" ? { kind, name: "oh-my-claudeagent" } as const : { kind } as const, wait: false,
});
const refused = (turnId: string, category: string | null, agentId?: string): Args<"turn.complete"> => ({
  answer: "I cannot help with that request.", durationMs: 10, isAborted: false, reason: "refusal",
  refusal: { category, explanation: null }, turnId, ...(agentId && { agentId }),
});
const edit = ($: Engine, text: string): Promise<unknown> => {
  const promptBox: { fill: unknown; edit?: EngineCall<"prompt.edit"> } = $.prompt;
  if (promptBox.edit === undefined) throw new Error("this engine offers no $.prompt.edit");
  return promptBox.edit({ origin: { kind: "composer" }, text: "", cursor: 0, start: 0, end: 0, inputText: text });
};

test("interactive user refusal submits one deferred follow-up and preserves the original result", async ($, on) => {
  const w = world(on);
  const submitted: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => (submitted.push(e.text), { text: e.text }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "original refusal" }));
  await $.session.start(start());
  await $.prompt.submit(prompt("Fix the test"));
  await $.turn.start({ text: "Fix the test", turnId: "user-1" });
  expect(await $.turn.complete(refused("user-1", "reasoning_extraction"))).toEqual({ text: "original refusal" });
  expect(submitted).toEqual(["Fix the test"]);
  await w.clock.settle();
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toContain("normal coding tools");
  expect(submitted[1]).toContain("observable evidence and actions taken, not private reasoning");
  await $.turn.complete(refused("user-1", "reasoning_extraction"));
  await w.clock.settle();
  expect(submitted).toHaveLength(2);
});

test("the follow-up's own refused turn starts no further follow-up", async ($, on) => {
  const w = world(on);
  const submitted: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => (submitted.push(e.text), { text: e.text }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await $.session.start(start());
  await $.prompt.submit(prompt("Review this task", "bridge"));
  await $.turn.start({ text: "Review this task", turnId: "user-2" });
  await $.turn.complete(refused("user-2", "reasoning_extraction"));
  await w.clock.settle();
  expect(submitted).toHaveLength(2);
  await $.turn.start({ text: submitted[1]!, turnId: "plugin-1" });
  await $.turn.complete(refused("plugin-1", "reasoning_extraction"));
  await w.clock.settle();
  expect(submitted).toHaveLength(2);
});

test("a usage-policy refusal such as cyber starts no follow-up", async ($, on) => {
  const w = world(on);
  const submitted: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => (submitted.push(e.text), { text: e.text }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await $.session.start(start());
  for (const category of ["cyber", "bio", "frontier_llm"]) {
    await $.prompt.submit(prompt(category));
    await $.turn.start({ text: category, turnId: category });
    await $.turn.complete(refused(category, category));
    await w.clock.settle();
  }
  expect(submitted).toEqual(["cyber", "bio", "frontier_llm"]);
});

test("OMCA_DISABLED_HOOKS=refusal-recovery turns the follow-up off", async ($, on) => {
  const w = world(on, {}, {}, { OMCA_DISABLED_HOOKS: "refusal-recovery" });
  const submitted: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => (submitted.push(e.text), { text: e.text }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await $.session.start(start());
  await $.prompt.submit(prompt("Fix the test"));
  await $.turn.start({ text: "Fix the test", turnId: "user-1" });
  await $.turn.complete(refused("user-1", "reasoning_extraction"));
  await w.clock.settle();
  expect(submitted).toEqual(["Fix the test"]);
});

test("a later independent user turn with the same text can recover after the plugin turn", async ($, on) => {
  const w = world(on);
  const submitted: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => (submitted.push(e.text), { text: e.text }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await $.session.start(start());
  await $.prompt.submit(prompt("original"));
  await $.turn.start({ text: "original", turnId: "original" });
  await $.turn.complete(refused("original", "reasoning_extraction"));
  await w.clock.settle();
  await $.turn.start({ text: submitted[1]!, turnId: "plugin-turn" });
  await $.turn.complete(refused("plugin-turn", "reasoning_extraction"));
  await w.clock.settle();
  await $.prompt.submit(prompt(submitted[1]!));
  expect(submitted).toHaveLength(3);
  await $.turn.start({ text: submitted[1]!, turnId: "later-user" });
  await $.turn.complete(refused("later-user", "reasoning_extraction"));
  await w.clock.settle();
  expect(submitted).toHaveLength(4);
});

for (const order of ["user-first", "plugin-first"] as const) test(`a competing queued user and plugin turn fail closed: ${order}`, async ($, on) => {
  const w = world(on);
  const submitted: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => (submitted.push(e.text), { text: e.text }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await $.session.start(start());
  await $.prompt.submit(prompt("original"));
  await $.turn.start({ text: "original", turnId: "original" });
  await $.turn.complete(refused("original", "reasoning_extraction"));
  await w.clock.settle();
  await $.prompt.submit(prompt(submitted[1]!));
  const turns = order === "user-first"
    ? [{ text: submitted[1]!, turnId: "competing-user" }, { text: submitted[1]!, turnId: "plugin-turn" }]
    : [{ text: submitted[1]!, turnId: "plugin-turn" }, { text: submitted[1]!, turnId: "competing-user" }];
  for (const turn of turns) {
    await $.turn.start(turn);
    await $.turn.complete(refused(turn.turnId, "reasoning_extraction"));
  }
  await w.clock.settle();
  expect(submitted).toHaveLength(3);
});

test("intervening user input cancels a pending recovery before queueing", async ($, on) => {
  const w = world(on);
  const submitted: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => (submitted.push(e.text), { text: e.text }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await $.session.start(start());
  await $.prompt.submit(prompt("first"));
  await $.turn.start({ text: "first", turnId: "first" });
  await $.turn.complete(refused("first", "reasoning_extraction"));
  await $.prompt.submit(prompt("new user request"));
  await w.clock.settle();
  expect(submitted).toEqual(["first", "new user request"]);
});

test("editing a draft cancels a pending recovery before queueing", async ($, on) => {
  const w = world(on);
  const submitted: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => (submitted.push(e.text), { text: e.text }));
  on("prompt.edit", (_$, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await $.session.start(start());
  await $.prompt.submit(prompt("first"));
  await $.turn.start({ text: "first", turnId: "first" });
  await $.turn.complete(refused("first", "reasoning_extraction"));
  await edit($, "new request");
  await w.clock.settle();
  expect(submitted).toEqual(["first"]);
});

test("user input queued before refusal completion also prevents recovery", async ($, on) => {
  const w = world(on);
  const submitted: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => (submitted.push(e.text), { text: e.text }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await $.session.start(start());
  await $.prompt.submit(prompt("first"));
  await $.turn.start({ text: "first", turnId: "first" });
  await $.prompt.submit(prompt("queued"));
  await $.turn.complete(refused("first", "reasoning_extraction"));
  await w.clock.settle();
  expect(submitted).toEqual(["first", "queued"]);
});

test("a dropped user prompt cannot turn an earlier SDK prompt with the same text into user origin", async ($, on) => {
  const w = world(on);
  const submitted: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => {
    submitted.push(e.text);
    return e.origin.kind === "composer" ? { drop: "blocked" } : { text: e.text };
  });
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await $.session.start(start());
  await $.prompt.submit(prompt("same", "sdk"));
  await $.prompt.submit(prompt("same"));
  await $.turn.start({ text: "same", turnId: "sdk-turn" });
  await $.turn.complete(refused("sdk-turn", "reasoning_extraction"));
  await w.clock.settle();
  expect(submitted).toEqual(["same", "same"]);
});

test("an empty-text prompt does not leave stale origin for the next turn", async ($, on) => {
  const w = world(on);
  const submitted: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => (submitted.push(e.text), { text: e.text }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await $.session.start(start());
  await $.prompt.submit(prompt(""));
  await $.turn.start({ text: "", turnId: "empty" });
  await $.turn.complete(refused("empty", "reasoning_extraction"));
  await $.prompt.submit(prompt("later user task"));
  await $.turn.start({ text: "later user task", turnId: "later" });
  await $.turn.complete(refused("later", "reasoning_extraction"));
  await w.clock.settle();
  expect(submitted).toHaveLength(3);
});

test("noninteractive, SDK, plugin, agent, unknown category and non-refusal turns do not recover", async ($, on) => {
  const w = world(on);
  const submitted: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => (submitted.push(e.text), { text: e.text }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await $.session.start(start(false));
  await $.prompt.submit(prompt("user"));
  await $.turn.start({ text: "user", turnId: "u0" });
  await $.turn.complete(refused("u0", "reasoning_extraction"));
  await $.session.start(start());
  for (const [kind, category] of [["sdk", "reasoning_extraction"], ["plugin", "reasoning_extraction"], ["composer", "other"], ["composer", null]] as const) {
    const turnId = `t-${submitted.length}`;
    await $.prompt.submit(prompt(turnId, kind));
    await $.turn.start({ text: turnId, turnId });
    await $.turn.complete(refused(turnId, category));
  }
  await $.prompt.submit(prompt("agent test"));
  await $.turn.start({ text: "agent test", turnId: "main" });
  await $.turn.complete(refused("main", "reasoning_extraction", "a-1"));
  await $.turn.complete({ answer: "done", durationMs: 10, isAborted: false, reason: "answer", turnId: "main" });
  for (const reason of ["aborted", "error"] as const) {
    await $.prompt.submit(prompt(reason));
    await $.turn.start({ text: reason, turnId: reason });
    await $.turn.complete({ answer: "no answer", durationMs: 10, isAborted: reason === "aborted", reason, turnId: reason });
  }
  await w.clock.settle();
  expect(submitted).toEqual(["user", "t-1", "t-2", "t-3", "t-4", "agent test", "aborted", "error"]);
});

test("a dropped recovery attempt is logged once and not retried", async ($, on) => {
  const w = world(on);
  let calls = 0;
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => {
    if (e.origin.kind === "composer") return { text: e.text };
    calls++;
    return { drop: "queue closed" };
  });
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await $.session.start(start());
  await $.prompt.submit(prompt("one"));
  await $.turn.start({ text: "one", turnId: "one" });
  await $.turn.complete(refused("one", "reasoning_extraction"));
  await w.clock.settle();
  await $.turn.complete(refused("one", "reasoning_extraction"));
  await w.clock.settle();
  expect(calls).toBe(1);
  expect(w.logs.some((line) => line.includes("refusal recovery dropped: queue closed"))).toBe(true);
  expect(w.toasts).toContain("OMCA could not start the refusal follow-up; the original refusal remains.");
  await $.prompt.submit(prompt("new independent task"));
  await $.turn.start({ text: "new independent task", turnId: "two" });
  await $.turn.complete(refused("two", "reasoning_extraction"));
  await w.clock.settle();
  expect(calls).toBe(2);
});
