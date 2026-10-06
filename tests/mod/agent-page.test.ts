import type { On, SessionMessage } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import type { RenderElement } from "claude-code";
import { childrenOf, isNode, type Node, pane, rows, run, type Size, topRows, usage, world } from "./world.ts";

const DOCK_120: Size = { columns: 120, rows: 40, placement: "dock" };
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";

const spawnOf = (n: number, description: string, prompt: string) =>
  ({
    tool_use_id: `toolu_${n}`,
    prompt,
    description,
    subagentType: "oh-my-claudeagent:executor",
    provider: { plugin: "oh-my-claudeagent", tier: "user" },
    parentModel: "claude-opus-5-5",
    background: true,
    fork: false,
  }) as const;

// Each test names its agents with its own prefix, so no module state of an earlier test is read as this one's.
function engine(on: On, prefix: string): void {
  let spawned = 0;
  on("agent.spawn", () => ({ model: "claude-sonnet-5-5", agentId: `${prefix}-${++spawned}` }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
}

const finish = ($: Engine, agentId: string, answer: string) =>
  $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: `t-${agentId}`, reason: "answer", agentId, usage: usage(2000, 500) });

// The engine's types drop `agentId` from a tool call's input; its loop carries it, and so does the test engine.
const call = ($: Engine, agentId: string, input: Record<string, unknown>) => $.tool.call({ ...input, agentId } as never);

type Page = { brief: string; source: string; calls: { tool: string; summary: string; ok: boolean | null; durationMs: number | null }[]; reply: string };

// What each atom was last set to, and every key set in order; the write still reaches the engine's own store.
function watchState(on: On): { read: (key: string) => unknown; keys: string[] } {
  const last = new Map<string, unknown>();
  const keys: string[] = [];
  on("state.set", (_$, e, next) => (last.set(e.key, e.value), keys.push(e.key), next(e)));
  return { read: (key) => last.get(key), keys };
}

// The header's mascot and its two lines are one row Box; the lines read as the rows they are beside it.
function pageRows(tree: RenderElement): string[] {
  const top = topRows(tree).flatMap((child) =>
    isNode(child) && child.props?.["key"] === "page-header" ? childrenOf(childrenOf(child)[1] as Node) : [child],
  );
  return rows({ type: "Box", children: top } as RenderElement);
}

const message = (role: "user" | "assistant", text: string): SessionMessage => ({ role, text, toolUses: [] });

const BRIEF = "Fix the heading parser.\nSkip fenced lines.\nRun bun test src/parser.spec.ts when done.";

// What the tools answer and what the clipboard does, set per test; the hooks beneath the plugins are registered up front.
type Doubles = { tool: (e: { tool: string }) => unknown; copied: string[]; isCopyable: boolean };

function doubles(on: On): Doubles {
  const d: Doubles = { tool: () => ({ result: {}, text: "ok" }), copied: [], isCopyable: true };
  on("tool.call", async (_$, e) => (await d.tool(e)) as never);
  on("ui.copy", (_$, e) => (d.copied.push(e.text), { value: d.isCopyable ? { isCopied: true } : { isCopied: false, reason: "no-clipboard" } }));
  return d;
}

async function runningAgent($: Engine, on: On, prefix: string) {
  const w = world(on, {});
  const state = watchState(on);
  const d = doubles(on);
  engine(on, prefix);
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "Fix the heading parser", "Fix the heading parser."));
  const id = `${prefix}-1`;
  w.agents = [{ id, description: "", type: "x", status: "running" }];
  w.conversations.set(id, [message("user", BRIEF), message("assistant", "Reading the parser.")]);
  const pagesOf = (): Record<string, Page> => (state.read("pages") ?? {}) as Record<string, Page>;
  return { w, id, state, pagesOf, d };
}

test("a lane head's button opens the page of a running agent: header, full brief, each call with its outcome and duration, and the reply", async ($, on) => {
  const { w, id, state, pagesOf, d } = await runningAgent($, on, "run");
  d.tool = async (e) => {
    await w.clock.advance(e.tool === "Bash" ? 2_000 : 300);
    return e.tool === "Bash" ? { result: { stdout: "boom" }, text: "boom", isError: true } : { result: { ok: true }, text: "ok" };
  };
  await call($, id, { tool: "Read", file_path: "/work/src/parser.ts" });
  await call($, id, { tool: "Bash", command: "bun test src/parser.spec.ts" });
  expect(state.keys.filter((key) => key === "pages")).toEqual([]);

  const ui = await $.ui.mount(pane("terminal", DOCK_120));
  expect(await ui.find({ key: `open-${id}` })).toBeDefined();
  await ui.press({ key: `open-${id}` });

  expect(state.keys.filter((key) => key === "pages")).toEqual(["pages"]);
  expect(pageRows(await ui.drawn()).slice(3)).toEqual([
    "◆ executor · Fix the heading par…",
    "◆ running · 2s · 0 tokens · ~$0.…",
    "Brief",
    BRIEF,
    "Tool calls · 2",
    "✓ Read src/parser.ts                          300ms",
    "✗ Bash bun test src/parser.spec.ts               2s",
    "Reply",
    "Reading the parser.",
    "b: Back  c: Copy brief  r: Reload",
  ]);
  expect(pagesOf()[id]?.calls).toEqual([
    { tool: "Read", summary: "src/parser.ts", ok: true, durationMs: 300 },
    { tool: "Bash", summary: "bun test src/parser.spec.ts", ok: false, durationMs: 2_000 },
  ]);
  await ui.unmount();
});

test("a finished agent's page is kept at its turn.complete from its transcript, and is there before anyone opens it", async ($, on) => {
  const { w, id, pagesOf } = await runningAgent($, on, "done");
  w.conversations.set(id, [message("user", BRIEF), message("assistant", "Looking."), message("assistant", ""), message("assistant", "Fixed it; the parser skips fences.")]);
  expect(pagesOf()).toEqual({});

  await w.clock.advance(65_000);
  await finish($, id, "Fixed it; the parser skips fences.");

  expect(pagesOf()[id]).toEqual({ brief: BRIEF, source: "messages", calls: [], reply: "Fixed it; the parser skips fences." });
  w.agents = [];
  const ui = await $.ui.mount(pane("terminal", DOCK_120));
  await ui.press({ key: `open-${id}` });
  expect(pageRows(await ui.drawn()).slice(3, 7)).toEqual([
    "◆ executor · Fix the heading par…",
    "✓ done · 1m05s · 2.5k tokens · ~…",
    "Brief",
    BRIEF,
  ]);
  await ui.unmount();
});

test("a finished agent whose transcript is denied keeps its page from the stored prompt, and says so", async ($, on) => {
  const { w, id, pagesOf } = await runningAgent($, on, "deny");
  w.conversations.delete(id);

  await finish($, id, "Fixed it.\nTests pass.");

  expect(pagesOf()[id]).toEqual({ brief: "Fix the heading parser.", source: "prompt", calls: [], reply: "Fixed it." });
  w.agents = [];
  const ui = await $.ui.mount(pane("terminal", DOCK_120));
  await ui.press({ key: `open-${id}` });
  expect(pageRows(await ui.drawn()).slice(5, 8)).toEqual([
    "Brief · stored prompt, no transcript",
    "Fix the heading parser.",
    "Tool calls · 0",
  ]);
  await ui.unmount();
});

test("two agents' parallel tool calls each land on their own agent", async ($, on) => {
  const w = world(on, {});
  const state = watchState(on);
  const d = doubles(on);
  engine(on, "par");
  d.tool = async (e) => {
    await w.clock.advance(e.tool === "Read" ? 500 : 100);
    return { result: {}, text: "ok" };
  };
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "First", "First."));
  await $.agent.spawn(spawnOf(2, "Second", "Second."));
  w.agents = ["par-1", "par-2"].map((id) => ({ id, description: "", type: "x", status: "running" }));

  await Promise.all([
    call($, "par-1", { tool: "Read", file_path: "/work/a.ts" }),
    call($, "par-2", { tool: "Grep", pattern: "heading" }),
    call($, "par-1", { tool: "Glob", pattern: "src/**/*.ts" }),
    call($, "par-2", { tool: "Bash", command: "just test" }),
  ]);
  await finish($, "par-1", "One.");
  await finish($, "par-2", "Two.");

  const pages = (state.read("pages") ?? {}) as Record<string, Page>;
  expect(pages["par-1"]?.calls.map((one) => [one.tool, one.summary]).sort()).toEqual([["Glob", "src/**/*.ts"], ["Read", "a.ts"]]);
  expect(pages["par-2"]?.calls.map((one) => [one.tool, one.summary]).sort()).toEqual([["Bash", "just test"], ["Grep", "heading"]]);
});

test("a main-loop tool call passes through unchanged and leaves no trace", async ($, on) => {
  const { w, id, pagesOf, d } = await runningAgent($, on, "main");
  const seen: unknown[] = [];
  const answer = { result: { content: "x" }, text: "x" };
  d.tool = (e) => (seen.push(e), answer);

  const result = await $.tool.call({ tool: "Read", file_path: "/work/src/parser.ts" });

  expect(result).toEqual(answer);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ tool: "Read", file_path: "/work/src/parser.ts" });
  expect(seen[0]).not.toHaveProperty("agentId");
  await finish($, id, "Done.");
  expect(pagesOf()[id]?.calls).toEqual([]);
  expect(w.logs.filter((line) => line.startsWith("agentsTracker"))).toEqual([]);
});

test("a secret in the brief, a call or the reply is masked before the page is stored, drawn or copied", async ($, on) => {
  const { w, id, pagesOf, d } = await runningAgent($, on, "mask");
  w.conversations.set(id, [message("user", `Rotate ${SECRET} now.`), message("assistant", `Rotated; the old key was ${SECRET}.`)]);
  await call($, id, { tool: "Bash", command: `curl -H "x-api-key: ${SECRET}" https://example.test` });
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  await ui.press({ key: `open-${id}` });
  await ui.press({ key: "c" });

  expect(d.copied).toEqual(["Rotate ‹masked› now."]);
  const stored = JSON.stringify(pagesOf());
  const drawn = JSON.stringify(await ui.drawn());
  for (const text of [stored, drawn, ...d.copied]) {
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain("abcdefghij");
  }
  expect(drawn).toContain("Rotate ‹masked› now.");
  await ui.unmount();
});

test("b returns to the lanes, and the lane's button opens the page again", async ($, on) => {
  const { id, state } = await runningAgent($, on, "back");
  const ui = await $.ui.mount(pane("terminal", DOCK_120));
  await ui.press({ key: `open-${id}` });
  expect(rows(await ui.drawn()).some((row) => row.startsWith("b: Back"))).toBe(true);

  await ui.press({ key: "b" });
  const lanes = rows(await ui.drawn());
  expect(lanes.some((row) => row.startsWith("b: Back"))).toBe(false);
  expect(lanes.at(-2)).toContain("d: Details");
  expect(await ui.find({ key: `open-${id}` })).toBeDefined();
  expect(state.read("agentPage")).toEqual({ id: null });
  await ui.unmount();
});

test("c copies the brief and says so in a toast, and says when the copy failed", async ($, on) => {
  const { w, id, d } = await runningAgent($, on, "copy");
  const ui = await $.ui.mount(pane("terminal", DOCK_120));
  await ui.press({ key: `open-${id}` });

  await ui.press({ key: "c" });
  d.isCopyable = false;
  await ui.press({ key: "c" });

  expect(d.copied).toEqual([BRIEF, BRIEF]);
  expect(w.toasts).toEqual(["Copied the brief", "Could not copy the brief: no-clipboard"]);
  await ui.unmount();
});

test("r reads the transcript and the recorded calls again", async ($, on) => {
  const { w, id, pagesOf } = await runningAgent($, on, "reload");
  const ui = await $.ui.mount(pane("terminal", DOCK_120));
  await ui.press({ key: `open-${id}` });
  expect(rows(await ui.drawn())).toContain("Tool calls · 0");

  w.conversations.set(id, [message("user", BRIEF), message("assistant", "Now reading the lexer.")]);
  await call($, id, { tool: "Read", file_path: "/work/src/lexer.ts" });
  expect(pagesOf()[id]?.calls).toEqual([]);
  await ui.press({ key: "r" });

  const drawn = rows(await ui.drawn());
  expect(drawn).toContain("Tool calls · 1");
  expect(drawn.at(-2)).toBe("Now reading the lexer.");
  await ui.unmount();
});

test("a page keeps at most 8 KiB of brief, 4 KiB of reply and the newest 120 calls, and pages for the newest 20 agents", async ($, on) => {
  const { w, id, pagesOf } = await runningAgent($, on, "caps");
  w.conversations.set(id, [message("user", "b".repeat(10_000)), message("assistant", "r".repeat(6_000))]);
  for (let n = 1; n <= 130; n++) await call($, id, { tool: "Read", file_path: `/work/f${n}.ts` });

  await finish($, id, "Done.");

  const page = pagesOf()[id];
  expect([page?.brief.length, page?.reply.length, page?.calls.length]).toEqual([8192, 4096, 120]);
  expect([page?.calls[0]?.summary, page?.calls.at(-1)?.summary]).toEqual(["f11.ts", "f130.ts"]);

  for (let n = 2; n <= 22; n++) {
    await $.agent.spawn(spawnOf(n, `Agent ${n}`, `Agent ${n}.`));
    await w.clock.advance(1_000);
    await finish($, `caps-${n}`, "Done.");
  }
  const kept = Object.keys(pagesOf()).sort();
  expect(kept).toHaveLength(20);
  expect(kept).not.toContain(id);
  expect(kept).not.toContain("caps-2");
  expect(kept).toContain("caps-22");
});

// A call's duration is null once its start was dropped, which is how the bound on the starts shows.
function held(d: Doubles): { gates: (() => void)[]; reached: () => number } {
  const gates: (() => void)[] = [];
  let reached = 0;
  d.tool = async () => {
    const n = reached++;
    await new Promise<void>((resolve) => (gates[n] = resolve));
    return { result: {}, text: "ok" };
  };
  return { gates, reached: () => reached };
}

test("of calls still in flight only the newest 500 starts are kept, so the oldest read no duration", async ($, on) => {
  const { w, id, d, pagesOf } = await runningAgent($, on, "pending");
  const hold = held(d);

  const calls = Array.from({ length: 520 }, (_, n) => call($, id, { tool: "Read", file_path: `/work/f${n}.ts` }));
  while (hold.reached() < 520) await w.clock.advance(1);
  for (const release of hold.gates.slice(20)) release();
  for (const release of hold.gates.slice(0, 20)) release();
  await Promise.all(calls);
  await finish($, id, "Done.");

  const durations = pagesOf()[id]?.calls.map((one) => one.durationMs);
  expect(durations).toHaveLength(120);
  expect(durations?.slice(0, 100).every((ms) => ms !== null)).toBe(true);
  expect(durations?.slice(100).every((ms) => ms === null)).toBe(true);
});

test("the agent's turn.complete drops the starts of calls still in flight", async ($, on) => {
  const { w, id, d, pagesOf } = await runningAgent($, on, "clear");
  const hold = held(d);

  const pending = call($, id, { tool: "Read", file_path: "/work/a.ts" });
  while (hold.reached() < 1) await w.clock.advance(1);
  await finish($, id, "Done.");
  hold.gates[0]?.();
  await pending;
  await finish($, id, "Done again.");

  expect(pagesOf()[id]?.calls).toEqual([{ tool: "Read", summary: "a.ts", ok: true, durationMs: null }]);
});
