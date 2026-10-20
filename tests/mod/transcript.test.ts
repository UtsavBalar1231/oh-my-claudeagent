import type { On, RenderSurface, ToolGroupCall, UserMessageTask } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { drain, PLUGIN, usage, world } from "./world.ts";

const ENGINE_ROW = "engine row";
const TASK: UserMessageTask = { id: "a-1", status: "completed", toolUseId: "toolu_1", durationMs: 3_270 };

// The glyph tier is set, so the rows read the same whatever the shell running the tests exports.
async function engine($: Engine, on: On) {
  const w = world(on, {}, {}, { OMCA_GLYPHS: "unicode" });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("agent.spawn", () => ({ model: "claude-sonnet-5-5", agentId: "a-1" }));
  on("turn.step", async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "",
      toolUses: e.index === 0 ? [{ id: "toolu_r", name: "Read", input: { file_path: "/work/src/cart.ts" } }] : [],
      stopReason: e.index === 0 ? "tool_use" : "end_turn",
      usage: usage(9_000, 2_900),
    };
  });
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [ENGINE_ROW] });
  });
  await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });
  return w;
}

type Found = { text: string; props: Record<string, unknown> };

// The engine's own row, and each row OMCA drew as one Text cut at its end, without the spans inside it.
const rowsOf = (found: readonly Found[]): string[] => found.filter(({ text, props }) => text === ENGINE_ROW || props["wrap"] === "truncate-end").map(({ text }) => text);

async function finishedAgent($: Engine, reason: "answer" | "error" = "answer") {
  await $.agent.spawn({
    tool_use_id: "toolu_1",
    prompt: "Review the rounding rule in the totals module.",
    description: "Review the rounding rule",
    subagentType: "oh-my-claudeagent:architect",
    provider: { plugin: PLUGIN, tier: "user" },
    parentModel: "claude-opus-5-5",
    background: true,
    fork: false,
  });
  for (const index of [0, 1]) await drain($.turn.step({ turnId: "t-a", index, model: "claude-sonnet-5-5", effort: "high", messageCount: 1, agentId: "a-1" }));
  await $.turn.complete({
    answer: "Rounding at the end is right; rounding each line would drift by a cent.\n\nDetails follow.",
    durationMs: 3_000,
    isAborted: false,
    turnId: "t-a",
    reason,
    agentId: "a-1",
  });
}

async function notice($: Engine, task: UserMessageTask, { surface = "terminal", isExpanded = false }: { surface?: RenderSurface; isExpanded?: boolean } = {}) {
  const mounted = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: "UserMessage",
    requestId: "notice-1",
    props: { text: 'Agent "Review the rounding rule" finished', origin: { kind: "task-notification" }, isExpanded, task },
  });
  const rows = rowsOf(await mounted.findAll({ type: "Text" }));
  await mounted.unmount();
  return rows;
}

test("a finished agent's notice is redrawn: its mark, role and task with the facts flush right, then its reply", async ($, on) => {
  await engine($, on);
  await finishedAgent($);

  const [head, said] = await notice($, TASK);
  expect(head).toBe(`✓ architect  Review the rounding rule${" ".repeat(19)}3s · 1 call · 23.8k tok`);
  expect(said).toBe("  ⎿  Rounding at the end is right; rounding each line would drift by a cent.");
});

test("the engine's word for how the task ended wins: a failed task reads failed", async ($, on) => {
  await engine($, on);
  await finishedAgent($);

  const [head] = await notice($, { ...TASK, status: "failed" });
  expect(head).toStartWith("✗ architect  Review the rounding rule");
  expect(head).toEndWith("failed · 3s · 1 call · 23.8k tok");
});

test("the engine's row stands for ctrl+o, for another surface, for an agent OMCA did not record and for other messages", async ($, on) => {
  await engine($, on);
  await finishedAgent($);

  expect(await notice($, TASK, { isExpanded: true })).toEqual([ENGINE_ROW]);
  expect(await notice($, TASK, { surface: "desktop" })).toEqual([ENGINE_ROW]);
  expect(await notice($, { ...TASK, id: "a-unknown" })).toEqual([ENGINE_ROW]);
  const typed = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", component: "UserMessage", requestId: "prompt-1", props: { text: "hello", origin: { kind: "composer" }, isExpanded: false } });
  expect(rowsOf(await typed.findAll({ type: "Text" }))).toEqual([ENGINE_ROW]);
  await typed.unmount();
});

const bash = (command: string, extra: Partial<ToolGroupCall> = {}): ToolGroupCall => ({
  tool_use_id: `toolu_${command}`,
  tool: "Bash",
  input: { command },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  ...extra,
});

async function group($: Engine, calls: ToolGroupCall[], { surface = "terminal", isExpanded = false }: { surface?: RenderSurface; isExpanded?: boolean } = {}) {
  const mounted = await $.ui.mount({ plugin: PLUGIN, surface, component: "ToolGroup", requestId: "group-1", props: { calls, isActive: false, isExpanded } });
  const texts = rowsOf(await mounted.findAll({ type: "Text" }));
  await mounted.unmount();
  return texts;
}

test("a folded shell group gets one receipt row per verification run under the engine's line", async ($, on) => {
  await engine($, on);
  const calls = [
    bash("just test", { output: { stdout: "12 pass, 0 fail\n", stderr: "", interrupted: false, isImage: false } }),
    bash("ls src", { output: { stdout: "cart.ts\n", stderr: "", interrupted: false, isImage: false } }),
    bash("just lint", { isErrored: true, output: "Exit code 1\n1 problem (1 error)\nerror: recipe `lint` failed on line 6 with exit code 1" }),
  ];

  expect(await group($, calls)).toEqual([ENGINE_ROW, "  ⎿  ✓ just test · 12 pass, 0 fail", "  ⎿  ✗ just lint · exit 1 · 1 problem (1 error)"]);
});

test("an unfolded group, a group with no verification run, a running one and another surface keep the engine's drawing", async ($, on) => {
  await engine($, on);
  const passed = bash("just test", { output: { stdout: "12 pass\n", stderr: "", interrupted: false, isImage: false } });

  expect(await group($, [passed], { isExpanded: true })).toEqual([ENGINE_ROW]);
  expect(await group($, [bash("ls src")])).toEqual([ENGINE_ROW]);
  expect(await group($, [bash("just test", { isRunning: true })])).toEqual([ENGINE_ROW]);
  expect(await group($, [passed], { surface: "desktop" })).toEqual([ENGINE_ROW]);
});

async function launch($: Engine, props: Record<string, unknown>, surface: RenderSurface = "terminal") {
  const mounted = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: "ToolUse",
    requestId: "toolu_1",
    props: { tool_use_id: "toolu_1", tool: "Agent", isRunning: false, isErrored: false, isInterrupted: false, ...props } as { tool_use_id: string; tool: string; input: unknown; isRunning: boolean; isErrored: boolean; isInterrupted: boolean },
  });
  const rows = rowsOf(await mounted.findAll({ type: "Text" }));
  await mounted.unmount();
  return rows;
}

const EXECUTOR = { subagent_type: "oh-my-claudeagent:executor", description: "Wire the order summary panel", prompt: "Wire it.", run_in_background: true };

test("an Agent call's own row names the agent and its task, with background flush right", async ($, on) => {
  await engine($, on);
  expect(await launch($, { input: EXECUTOR })).toEqual([`◆ executor  Wire the order summary panel${" ".repeat(29)}background`]);
});

test("a call that waits for its agent ends on its result mark", async ($, on) => {
  await engine($, on);
  const waited = { ...EXECUTOR, run_in_background: false };
  expect(await launch($, { input: waited, isRunning: true })).toEqual(["◆ executor  Wire the order summary panel"]);
  expect(await launch($, { input: waited, isErrored: true })).toEqual(["✗ executor  Wire the order summary panel"]);
});

test("ctrl+o, a call still streaming its input and another surface keep the engine's row", async ($, on) => {
  await engine($, on);
  expect(await launch($, { input: EXECUTOR, isExpanded: true })).toEqual([ENGINE_ROW]);
  expect(await launch($, { input: {} })).toEqual([ENGINE_ROW]);
  expect(await launch($, { input: EXECUTOR }, "desktop")).toEqual([ENGINE_ROW]);
});
