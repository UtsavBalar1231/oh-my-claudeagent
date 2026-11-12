import type { On, RenderSurface } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { drain, PLUGIN, usage, world } from "./world.ts";

const ENGINE_ROW = "engine row";

const BRIEF = [
  "[CONTEXT]: Map every caller of the shared router in `src/`.",
  "",
  "[GOAL]: Decide which callers go through the harness **today**.",
  "",
  "[REQUEST]:",
  "1. Read every module that imports the router.",
  "2. Return a table.",
].join("\n");
const BODIES = ["Map every caller of the shared router in `src/`.", "Decide which callers go through the harness **today**.", "1. Read every module that imports the router.\n2. Return a table."];
const SIZE = "200 chars · 7 lines";

const NUMBERED = ["1. TASK: Wire the panel.", "", "2. DONE WHEN:", "- it renders"].join("\n");

async function engine($: Engine, on: On, env: Record<string, string> = {}) {
  const w = world(on, {}, {}, { OMCA_GLYPHS: "unicode", ...env });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("agent.spawn", () => ({ model: "claude-sonnet-5-5-20261101", agentId: "a-1" }));
  on("turn.step", async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: usage(9_000, 2_900) };
  });
  on("tool.call", () => ({ result: {} }) as never);
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [ENGINE_ROW] });
  });
  await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });
  return w;
}

async function spawn($: Engine, prompt: string) {
  await $.agent.spawn({
    tool_use_id: "toolu_1",
    prompt,
    description: "Map the callers",
    subagentType: "oh-my-claudeagent:explorer",
    provider: { plugin: PLUGIN, tier: "user" },
    parentModel: "claude-opus-5-5",
    background: true,
    fork: false,
  });
}

type Origin = { kind: "coordinator" } | { kind: "composer" } | { kind: "task-notification" };

async function row($: Engine, text: string, { surface = "terminal", isExpanded = false, origin = { kind: "coordinator" } }: { surface?: RenderSurface; isExpanded?: boolean; origin?: Origin } = {}) {
  const mounted = await $.ui.mount({ plugin: PLUGIN, surface, component: "UserMessage", requestId: "brief-1", props: { text, origin, isExpanded } });
  const texts = await mounted.findAll({ type: "Text" });
  const markdown = (await mounted.findAll({ type: "Markdown" })).map(({ props }) => props["text"]);
  const labels = texts.filter(({ props }) => props["color"] === "claude").map(({ text: label, props }) => ({ label, weight: props["weight"] }));
  const header = texts.filter(({ props }) => props["wrap"] === "truncate-end").map(({ text: line }) => line);
  const gutter = texts.filter(({ text: line }) => line === "❯ " || line === "> ").map(({ text: line, props }) => ({ line, color: props["color"] }));
  const isEngine = texts.some(({ text: line }) => line === ENGINE_ROW);
  await mounted.unmount();
  return { header, gutter, labels, markdown, isEngine };
}

test("a brief main sent a spawned agent draws the gutter, a header with type, model and size, bold labels and one Markdown per field", async ($, on) => {
  await engine($, on);
  await spawn($, BRIEF);

  const drawn = await row($, BRIEF);
  expect(drawn.isEngine).toBe(false);
  expect(drawn.gutter).toEqual([{ line: "❯ ", color: "inactive" }]);
  expect(drawn.header).toEqual([`explorer · sonnet-5-5 · ${SIZE}`]);
  expect(drawn.labels).toEqual([
    { label: "CONTEXT", weight: "semibold" },
    { label: "GOAL", weight: "semibold" },
    { label: "REQUEST", weight: "semibold" },
  ]);
  expect(drawn.markdown).toEqual(BODIES);
});

test("the header carries the agent's effort once a step has reported it", async ($, on) => {
  await engine($, on);
  const prompt = `${BRIEF}\n\n[NOTE]: effort`;
  await spawn($, prompt);
  expect((await row($, prompt)).header).toEqual([`explorer · sonnet-5-5 · ${briefSizeOf(prompt)}`]);

  await drain($.turn.step({ turnId: "t-a", index: 0, model: "claude-sonnet-5-5", effort: "high", messageCount: 1, agentId: "a-1" }));
  expect((await row($, prompt)).header).toEqual([`explorer · sonnet-5-5 · high · ${briefSizeOf(prompt)}`]);
});

const briefSizeOf = (text: string): string => `${text.length} chars · ${text.split("\n").length} lines`;

test("the header colors the agent's name and dims the rest", async ($, on) => {
  await engine($, on);
  await spawn($, "Wire it up.\nCarefully.");
  const mounted = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", component: "UserMessage", requestId: "brief-2", props: { text: "Wire it up.\nCarefully.", origin: { kind: "coordinator" }, isExpanded: false } });
  const parts = await mounted.findAll({ type: "Text", text: /explorer|sonnet-5-5/ });
  const name = parts.find(({ text }) => text === "explorer");
  const rest = parts.find(({ text }) => text === " · sonnet-5-5 · 22 chars · 2 lines");
  expect(name?.text).toBe("explorer");
  expect(name?.props["color"]).toBe("blue_FOR_SUBAGENTS_ONLY");
  expect(name?.props["weight"]).toBe("semibold");
  expect(rest?.text).toBe(" · sonnet-5-5 · 22 chars · 2 lines");
  expect(rest?.props["color"]).toBe("inactive");
  await mounted.unmount();
});

test("a numbered label puts its number in front, dim and not bold", async ($, on) => {
  await engine($, on);
  const mounted = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", component: "UserMessage", requestId: "brief-3", props: { text: NUMBERED, origin: { kind: "coordinator" }, isExpanded: false } });
  expect((await mounted.findAll({ type: "Text", text: /^(?:1\. TASK|2\. DONE WHEN)$/ })).map(({ props }) => [props["color"], props["weight"]])).toEqual([
    [undefined, undefined],
    [undefined, undefined],
  ]);
  const labels = await mounted.findAll({ type: "Text", text: /^(?:TASK|DONE WHEN)$/ });
  expect(labels.map(({ text, props }) => [text, props["color"], props["weight"]])).toEqual([["TASK", "claude", "semibold"], ["DONE WHEN", "claude", "semibold"]]);
  const nums = await mounted.findAll({ type: "Text", text: /^\d\. $/ });
  expect(nums.map(({ text, props }) => [text, props["color"], props["weight"]])).toEqual([["1. ", "inactive", undefined], ["2. ", "inactive", undefined]]);
  expect((await mounted.findAll({ type: "Markdown" })).map(({ props }) => props["text"])).toEqual(["Wire the panel.", "- it renders"]);
  await mounted.unmount();
});

test("a message main sent with SendMessage draws the follow-up header", async ($, on) => {
  await engine($, on);
  const message = "Also check the generated adapters.\nSkip vendored code.";
  expect((await row($, message)).header).toEqual([briefSizeOf(message)]);

  await $.tool.call({ tool: "SendMessage", to: "a-1", message });
  const drawn = await row($, message);
  expect(drawn.header).toEqual([`follow-up · ${briefSizeOf(message)}`]);
  expect(drawn.markdown).toEqual([message]);
  expect(drawn.labels).toEqual([]);
});

test("a row with no record draws the size alone", async ($, on) => {
  await engine($, on);
  const drawn = await row($, BRIEF);
  expect(drawn.header).toEqual([SIZE]);
  expect(drawn.markdown).toEqual(BODIES);
});

test("ctrl+o draws the same tree", async ($, on) => {
  await engine($, on);
  const text = `${BRIEF}\n\n[NOTE]: expanded`;
  await spawn($, text);
  expect(await row($, text, { isExpanded: true })).toEqual(await row($, text));
});

test("a resumed agent and a subagent's SendMessage record nothing", async ($, on) => {
  await engine($, on);
  const resumed = "Resume brief.";
  await $.agent.spawn({
    tool_use_id: "toolu_2",
    prompt: resumed,
    description: "Resume",
    subagentType: "oh-my-claudeagent:explorer",
    provider: { plugin: PLUGIN, tier: "user" },
    parentModel: "claude-opus-5-5",
    background: true,
    fork: false,
    resume: { agentId: "a-1" },
  });
  expect((await row($, resumed)).header).toEqual(["13 chars · 1 line"]);

  await $.tool.call({ tool: "SendMessage", to: "main", message: "From a subagent.", agentId: "a-9" } as never);
  expect((await row($, "From a subagent.")).header).toEqual(["16 chars · 1 line"]);
});

test("the engine's row stands for the composer, a task notification, another surface, the kill switch and a very long text", async ($, on) => {
  await engine($, on);
  const long = "x".repeat(100_001);
  await spawn($, long);
  await spawn($, BRIEF);

  expect((await row($, "hello", { origin: { kind: "composer" } })).isEngine).toBe(true);
  expect((await row($, "done", { origin: { kind: "task-notification" } })).isEngine).toBe(true);
  expect((await row($, BRIEF, { surface: "desktop" })).isEngine).toBe(true);
  expect((await row($, long)).isEngine).toBe(true);
  expect((await row($, "x".repeat(100_000))).isEngine).toBe(false);
});

test("OMCA_DISABLED_HOOKS=brief-rows keeps the engine's row", async ($, on) => {
  await engine($, on, { OMCA_DISABLED_HOOKS: "bash-guard,brief-rows" });
  expect((await row($, BRIEF)).isEngine).toBe(true);
});

test("the ASCII tier draws a > gutter", async ($, on) => {
  await engine($, on, { OMCA_GLYPHS: "ascii" });
  const drawn = await row($, BRIEF);
  expect(drawn.gutter).toEqual([{ line: "> ", color: "inactive" }]);
  expect(drawn.header).toEqual(["200 chars - 7 lines"]);
});
