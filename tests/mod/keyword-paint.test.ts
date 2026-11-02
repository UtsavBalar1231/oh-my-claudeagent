import type { On, PromptDecoration } from "claude-code";
import { type Engine, type EngineCall, expect, test } from "claude-code/testing";
import { ROOT, world } from "./world.ts";

const edit = async ($: Engine, text: string): Promise<{ text: string; decorations?: PromptDecoration[] }> => {
  const box: { fill: unknown; edit?: EngineCall<"prompt.edit"> } = $.prompt;
  if (box.edit === undefined) throw new Error("this engine offers no $.prompt.edit");
  return box.edit({ origin: { kind: "composer" }, text: "", cursor: 0, start: 0, end: 0, inputText: text });
};

const change = ($: Engine, text: string): Promise<unknown> => {
  const box: { fill: unknown; change?: EngineCall<"prompt.change"> } = $.prompt;
  if (box.change === undefined) throw new Error("this engine offers no $.prompt.change");
  return box.change({ text, cursor: text.length, origin: { kind: "engine" } });
};

const submit = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: "composer" }, wait: false });

function setup(on: On, env: Readonly<Record<string, string>> = {}) {
  world(on, {}, {}, env);
  const paints: unknown[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  on("prompt.change", (_$, e) => ({ text: e.text }));
  on("prompt.edit", (_$, e) => ({ text: e.inputText, cursor: e.inputText.length }));
  on("prompt.read", () => ({ value: { text: "recalled: fix build", cursor: 0 } }));
  on("prompt.paint", (_$, e) => (paints.push(e), { value: { isPainted: true, text: e.text ?? "", cursor: 0 } }));
  return { paints };
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });

const TRIGGERS = { options: { enableKeywordTriggers: true } };

test("typing a trigger phrase underlines the phrase and nothing else", TRIGGERS, async ($, on) => {
  setup(on);
  await start($);
  const result = await edit($, "please create plan now");
  expect(result.text).toBe("please create plan now");
  expect(result.decorations).toEqual([{ start: 7, end: 18, underline: true }]);
});

test("a draft with no phrase, a slash command or a quoted phrase carries no runs", TRIGGERS, async ($, on) => {
  setup(on);
  await start($);
  expect((await edit($, "fix the login bug")).decorations).toBeUndefined();
  expect((await edit($, "/oh-my-claudeagent:plan create plan")).decorations).toBeUndefined();
  expect((await edit($, 'say "create plan"')).decorations).toBeUndefined();
});

test("a phrase that has fired this session is no longer marked, and another still is", TRIGGERS, async ($, on) => {
  setup(on);
  await start($);
  await submit($, "create plan");
  expect((await edit($, "create plan")).decorations).toBeUndefined();
  expect((await edit($, "fix build")).decorations).toEqual([{ start: 0, end: 9, underline: true }]);
});

test("a slash command that names a phrase does not count as the phrase having fired", TRIGGERS, async ($, on) => {
  setup(on);
  await start($);
  await submit($, "/oh-my-claudeagent:plan create plan");
  expect((await edit($, "create plan")).decorations).toEqual([{ start: 0, end: 11, underline: true }]);
});

test("the keyword detector's kill switch turns the marks off", TRIGGERS, async ($, on) => {
  setup(on, { OMCA_DISABLED_HOOKS: "keyword-detector" });
  await start($);
  expect((await edit($, "create plan")).decorations).toBeUndefined();
});

test("with the option off, as by default, no draft carries runs", async ($, on) => {
  setup(on);
  await start($);
  expect((await edit($, "create plan")).decorations).toBeUndefined();
});

test("a recalled draft, which raises no edit, is painted from what the box holds", TRIGGERS, async ($, on) => {
  const { paints } = setup(on);
  await start($);
  await change($, "recalled: fix build");
  expect(paints).toEqual([{ text: "recalled: fix build", decorations: [{ start: 10, end: 19, underline: true }] }]);
});

test("a client with no $.prompt.paint leaves the draft alone and logs why", TRIGGERS, async ($, on) => {
  const w = world(on);
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.change", (_$, e) => ({ text: e.text }));
  on("prompt.read", () => ({ value: { text: "fix build", cursor: 0 } }));
  on("prompt.paint", () => ({ deny: "prompt.paint is not available" }));
  await start($);
  await change($, "fix build");
  expect(w.logs.some((line) => line.includes("keywordPaint post prompt.change failed"))).toBe(true);
});

test("with the option off, a recalled draft is not read or painted", async ($, on) => {
  const { paints } = setup(on);
  await start($);
  await change($, "fix build");
  expect(paints).toEqual([]);
});
