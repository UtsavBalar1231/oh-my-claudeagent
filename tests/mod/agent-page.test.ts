import type { On, SessionMessage } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import type { RenderElement } from "claude-code";
import { clockOf } from "../../src/core/ui-kit.ts";
import { childrenOf, isNode, type Node, pane, rows, run, type Size, topRows, usage, world } from "./world.ts";

const DOCK_120: Size = { columns: 120, rows: 40, placement: "dock" };
const INLINE_80x24: Size = { columns: 80, rows: 24, placement: "inline" };
const STARTED = Date.UTC(2026, 9, 2, 12, 0, 0);
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

// The brief and the reply draw as Markdown, which rows leave out; this reads one by its key.
type Finder = { find: (match: { key: string }) => Promise<{ type: string; props: Readonly<Record<string, unknown>> } | undefined> };
async function markdownText(ui: Finder, key: string): Promise<unknown> {
  const found = await ui.find({ key });
  return found?.type === "Markdown" ? found.props["text"] : undefined;
}

// The header's mascot and its lines are one row Box, and the body's window holds its units in a clipped Box; both read as the rows they are.
function pageRows(tree: RenderElement): string[] {
  const unwrap = (child: unknown): unknown[] => {
    if (!isNode(child)) return [child];
    if (child.props?.["key"] === "page-header") return childrenOf(childrenOf(child)[1] as Node);
    if (child.props?.["key"] !== "page-body") return [child];
    return childrenOf(child).flatMap((part) => (isNode(part) && part.props?.["overflow"] === "hidden" ? childrenOf(childrenOf(part)[0] as Node) : [part]));
  };
  return rows({ type: "Box", children: topRows(tree).flatMap(unwrap) } as RenderElement);
}

// The page from its identity row down, whatever tab rows the pane draws above it.
function pageBody(tree: RenderElement): string[] {
  const all = pageRows(tree);
  return all.slice(all.findIndex((row) => row.startsWith("◆ executor")));
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
  expect(pageBody(await ui.drawn())).toEqual([
    "◆ executor · Fix the heading par…",
    "◆ running · 2s · 0 tokens · ~$0.…",
    "sonnet-5-5",
    "0 tool calls",
    `started ${clockOf(STARTED)}`,
    "Brief",
    "",
    "",
    "",
    " ",
    "Tool calls · 2",
    "✓ Read src/parser.ts                          300ms",
    "✗ Bash bun test src/parser.spec.ts               2s",
    " ",
    "Reply",
    "",
    "b: Back  c: Copy brief  r: Reload",
  ]);
  expect(await Promise.all([0, 1, 2].map((line) => markdownText(ui, `brief-${line}-0`)))).toEqual(BRIEF.split("\n"));
  expect(await markdownText(ui, "reply-0-0")).toBe("Reading the parser.");
  expect((await ui.find({ type: "Code" }))?.props).toEqual({ source: "bun test src/parser.spec.ts", language: "bash", wrap: "truncate-end" });
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
  expect(pageBody(await ui.drawn()).slice(0, 6)).toEqual([
    "◆ executor · Fix the heading par…",
    "✓ done · 1m05s · 2.5k tokens · ~…",
    "sonnet-5-5",
    "0 tool calls",
    `started ${clockOf(STARTED)} · ended ${clockOf(STARTED + 65_000)}`,
    "Brief",
  ]);
  expect(await markdownText(ui, "brief-0-0")).toBe("Fix the heading parser.");
  expect(await markdownText(ui, "reply-0-0")).toBe("Fixed it; the parser skips fences.");
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
  expect(pageBody(await ui.drawn()).slice(5, 9)).toEqual([
    "Brief · stored prompt, no transcript",
    "",
    " ",
    "Tool calls · 0",
  ]);
  expect(await markdownText(ui, "brief-0-0")).toBe("Fix the heading parser.");
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
  expect(pageRows(await ui.drawn())).toContain("Tool calls · 0");

  w.conversations.set(id, [message("user", BRIEF), message("assistant", "Now reading the lexer.")]);
  await call($, id, { tool: "Read", file_path: "/work/src/lexer.ts" });
  expect(pagesOf()[id]?.calls).toEqual([]);
  await ui.press({ key: "r" });

  const drawn = pageRows(await ui.drawn());
  expect(drawn).toContain("Tool calls · 1");
  expect(await markdownText(ui, "reply-0-0")).toBe("Now reading the lexer.");
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

test("past 20 agents the calls of the agent that called least recently are dropped, not those of the first to call", async ($, on) => {
  const { id, pagesOf } = await runningAgent($, on, "recent");
  await call($, id, { tool: "Read", file_path: "/work/first.ts" });
  for (let n = 1; n <= 19; n++) await call($, `recent-other-${n}`, { tool: "Read", file_path: `/work/o${n}.ts` });
  await call($, id, { tool: "Read", file_path: "/work/again.ts" });
  await call($, "recent-other-20", { tool: "Read", file_path: "/work/o20.ts" });

  await finish($, id, "Done.");
  await finish($, "recent-other-1", "Done.");

  expect(pagesOf()[id]?.calls.map((one) => one.summary)).toEqual(["first.ts", "again.ts"]);
  expect(pagesOf()["recent-other-1"]?.calls).toEqual([]);
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

const KEYS_ROW = "b: Back  c: Copy brief  r: Reload";
const CUE = "↓ more · wheel to scroll";

test("on a short pane the page opens on the agent's identity with its keys last and a cue for what is below, and the ring is not put on Back", async ($, on) => {
  const { w, id } = await runningAgent($, on, "short");
  const ui = await $.ui.mount(pane("terminal", INLINE_80x24));

  await ui.press({ key: `open-${id}` });
  await w.clock.advance(10);

  const body = pageBody(await ui.drawn()).map((row) => row.trimEnd());
  expect(body.slice(0, 3)).toEqual(["◆ executor · Fix the heading parser", "◆ running · 0s · 0 tokens · ~$0.00", "Brief"]);
  expect(body.slice(-2)).toEqual([CUE, KEYS_ROW]);
  expect(await ui.find({ type: "Raster" })).toBeUndefined();
  expect(w.focused).not.toContain("b");
  expect(w.logs.filter((line) => line.includes("could not focus"))).toEqual([]);
  await ui.unmount();
});

test("below six rows the identity shares one line, so the window keeps its cue", async ($, on) => {
  const { id } = await runningAgent($, on, "tiny");
  const base = pane("terminal", INLINE_80x24);
  const ui = await $.ui.mount({ ...base, props: { ...base.props, scroll: { offset: 0, bodyRows: 6 } } } as never);

  await ui.press({ key: `open-${id}` });
  await ui.redraw();

  const body = pageBody(await ui.drawn()).map((row) => row.trimEnd());
  expect(body[0]).toBe("◆ executor · ◆ running · 0s · 0 tokens · ~$0.00 · Fix the heading parser");
  expect(body[1]).toBe("Brief");
  expect(body.slice(-2)).toEqual([CUE, KEYS_ROW]);
  await ui.unmount();
});

test("beside the full mascot the header lists the model, the tool calls and the times", async ($, on) => {
  const { id } = await runningAgent($, on, "facts");
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  await ui.press({ key: `open-${id}` });

  expect(pageBody(await ui.drawn()).slice(2, 5)).toEqual(["sonnet-5-5", "0 tool calls", `started ${clockOf(STARTED)}`]);
  const header = (await ui.find({ key: "page-header" })) as unknown as Node;
  expect((childrenOf(header)[0] as Node).props?.["columns"]).toBe(16);
  await ui.unmount();
});

test("an agent with no recorded model has two fact rows, which the mini mascot's four rows hold", async ($, on) => {
  const w = world(on, {});
  doubles(on);
  on("agent.spawn", () => ({ model: "", agentId: "bare-1" }));
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "Fix the heading parser", "Fix the heading parser."));
  w.agents = [{ id: "bare-1", description: "", type: "x", status: "running" }];
  w.conversations.set("bare-1", [message("user", BRIEF), message("assistant", "Reading the parser.")]);
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  await ui.press({ key: "open-bare-1" });

  const header = (await ui.find({ key: "page-header" })) as unknown as Node;
  expect(pageBody(await ui.drawn()).slice(2, 4)).toEqual(["0 tool calls", `started ${clockOf(STARTED)}`]);
  expect((childrenOf(header)[0] as Node).props?.["columns"]).toBe(15);
  await ui.unmount();
});
