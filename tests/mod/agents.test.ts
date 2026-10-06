import type { On, RenderElement, TurnStepToolUse } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { childrenOf, drain, isAscii, isNode, type Node, nodeByKey, pane, run, type Size, usage, world } from "./world.ts";

const DOCK_120: Size = { columns: 120, rows: 40, placement: "dock" };
// Too short for three relaxed lanes, and for one relaxed lane with a finished one under it.
const DOCK_COMPACT: Size = { columns: 120, rows: 18, placement: "dock" };
const DOCK_TINY: Size = { columns: 120, rows: 13, placement: "dock" };
const INLINE_80: Size = { columns: 80, rows: 40, placement: "inline" };
const INLINE_200: Size = { columns: 200, rows: 50, placement: "inline" };

const spawnOf = (n: number, type: string, description: string, prompt: string) =>
  ({
    tool_use_id: `toolu_${n}`,
    prompt,
    description,
    subagentType: `oh-my-claudeagent:${type}`,
    provider: { plugin: "oh-my-claudeagent", tier: "user" },
    parentModel: "claude-opus-5-5",
    background: true,
    fork: false,
  }) as const;

type Step = { uses: TurnStepToolUse[]; answer?: string };

// Each agent's steps by index; an agent id is `a-<n>` in spawn order.
function engine(on: On, steps: Readonly<Record<string, readonly Step[]>>, stepModel = "claude-sonnet-5-5"): void {
  let spawned = 0;
  on("agent.spawn", () => ({ model: "claude-sonnet-5-5", agentId: `a-${++spawned}` }));
  on("turn.step", async function* (_$, e) {
    const step = steps[e.agentId ?? ""]?.[e.index] ?? { uses: [] };
    return {
      turnId: e.turnId,
      index: e.index,
      answer: step.answer ?? "",
      toolUses: step.uses,
      stopReason: step.uses.length > 0 ? "tool_use" : "end_turn",
      usage: usage(1200, 300, stepModel),
    };
  });
  on("turn.complete", (_$, e) => ({ text: e.answer }));
}

async function stepAll($: Engine, agentId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    const stream = $.turn.step({ turnId: `t-${agentId}`, index, model: "claude-sonnet-5-5", effort: "high", messageCount: 1, agentId });
    await drain(stream);
  }
}

const finish = ($: Engine, agentId: string, answer: string, reason: "answer" | "aborted" | "error" = "answer") =>
  $.turn.complete({ answer, durationMs: 1000, isAborted: reason === "aborted", turnId: `t-${agentId}`, reason, agentId, usage: usage(2000, 500) });

const isCard = (node: Node) => node.props?.["position"] === "absolute";
// A tool row: the spinner, the tool and its detail on the left, the call count at the right edge.
const spread = (left: string, right: string, width = 51) => `${left}${" ".repeat(width - left.length - right.length)}${right}`;

function textOf(element: unknown): string {
  if (typeof element === "string") return element;
  if (!isNode(element) || isCard(element)) return "";
  if (element.type === "Button") return typeof element.props?.["hotkey"] === "string" ? `${element.props["hotkey"]}: ${String(element.props["label"])}` : String(element.props?.["label"]);
  const gap = " ".repeat(typeof element.props?.["columnGap"] === "number" ? element.props["columnGap"] : 0);
  return childrenOf(element).map(textOf).join(element.type === "Box" ? gap : "");
}

// A relaxed lane is a row of its mini and a column of its rows; the mini draws no text, so only the rows count.
const blockRows = (node: unknown): string[] => {
  const [, column] = isNode(node) && node.type === "Box" && node.props?.["flexDirection"] === "row" ? childrenOf(node) : [];
  return isNode(column) && column.props?.["flexDirection"] === "column" ? childrenOf(column).map(textOf) : [textOf(node)];
};

/** The body rows as the terminal stacks them: a lane's hover card left out, a lane's anchor rows each on their own, a relaxed lane's rows without its mini. */
function body(tree: RenderElement): string[] {
  const top = isNode(tree) ? childrenOf(tree) : [];
  return top.flatMap((child) =>
    isNode(child) && child.type === "Box" && child.props?.["flexDirection"] === "column"
      ? childrenOf(child)
          .filter((one) => !(isNode(one) && isCard(one)))
          .flatMap(blockRows)
      : [textOf(child)],
  );
}

const STEPS: Record<string, Step[]> = {
  "a-1": [
    { uses: [{ name: "Read", input: { file_path: "/work/src/parser.ts" } }, { name: "Grep", input: { pattern: "heading" } }], answer: "Reading the parser.\nFound the heading rule." },
    { uses: [{ name: "Edit", input: { file_path: "/work/src/parser.ts" } }] },
    { uses: [{ name: "Bash", input: { command: "bun test src/parser.spec.ts" } }] },
  ],
  "a-2": [
    { uses: [{ name: "Glob", input: { pattern: "src/**/*.ts" } }] },
    { uses: [{ name: "mcp__plugin_oh-my-claudeagent_omca__ast_search", input: { pattern: "route($A)" } }] },
  ],
  "a-3": [{ uses: [{ name: "Read", input: { file_path: "/work/plans/p.md" } }] }],
};

async function threeAgents($: Engine, on: On) {
  const w = world(on, {});
  engine(on, STEPS);
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "executor", "Fix the heading parser", "Fix the heading parser so fenced lines are skipped."));
  await $.agent.spawn(spawnOf(2, "explorer", "Map the router callers", "Find every caller of the router."));
  await $.agent.spawn(spawnOf(3, "architect", "Review the ledger design", "Review the ledger rotation."));
  w.agents = ["a-1", "a-2", "a-3"].map((id) => ({ id, description: "", type: "x", status: "running" }));
  await stepAll($, "a-1", 3);
  await stepAll($, "a-2", 2);
  await stepAll($, "a-3", 1);
  return w;
}

test("a body too short for every relaxed lane gives each running agent a compact lane: identity, task, effort and elapsed, then its current tool and calls", async ($, on) => {
  const w = await threeAgents($, on);
  await w.clock.advance(66_000);
  const ui = await $.ui.mount(pane("terminal", DOCK_COMPACT));
  expect(await ui.find({ type: "Raster" })).toBeUndefined();

  expect(body(await ui.drawn()).slice(3)).toEqual([
    "◆ executor · Fix the heading parser    high   1m06s",
    spread("  · Bash bun test src/parser.spec.ts", "4 calls"),
    "◆ explorer · Map the router callers    high   1m06s",
    spread("  · ast_search", "2 calls"),
    "◆ architect · Review the ledger desi…  high   1m06s",
    spread("  · Read plans/p.md", "1 call"),
    "d: Details  3 running · 0 finished · 9.0k tokens",
  ]);
  await ui.unmount();
});

test("the lane widens with the body, keeping the model column, at 80 and 200 columns", async ($, on) => {
  const w = await threeAgents($, on);
  await stepAll($, "a-3", 1);
  await w.clock.advance(66_000);

  const at80 = await $.ui.mount(pane("terminal", INLINE_80));
  expect(body(await at80.drawn()).slice(1, 3)).toEqual([
    "◆ executor · Fix the heading parser              sonnet-5-5  high   1m06s",
    spread("  · Bash bun test src/parser.spec.ts", "4 calls", 73),
  ]);
  await at80.unmount();

  const at200 = await $.ui.mount(pane("terminal", INLINE_200));
  const rows = body(await at200.drawn());
  expect(rows[1]).toBe(`◆ executor · Fix the heading parser${" ".repeat(134)}sonnet-5-5  high   1m06s`);
  expect(rows.at(-1)).toBe("d: Details  3 running · 0 finished · 10.5k tokens");
  await at200.unmount();
});

test("the current tool's name draws in text with the call count muted at the right edge, the identity glyph in its key, the name in text and the columns muted", async ($, on) => {
  await threeAgents($, on);
  const ui = await $.ui.mount(pane("terminal", INLINE_80));
  const lane = await ui.find({ key: "tools-a-1" });
  const head = await ui.find({ key: "lane-a-1" });
  const styled = (node: unknown): [string, unknown, unknown][] =>
    isNode(node) ? (childrenOf(childrenOf(node)[0] as Node) as Node[]).map((piece) => [textOf(piece), piece.props?.["color"], piece.props?.["backgroundColor"]]) : [];

  expect(styled(lane)).toEqual([
    ["  ", undefined, undefined],
    ["·", "claude", undefined],
    [" ", undefined, undefined],
    ["Bash", "text", undefined],
    [" bun test src/parser.spec.ts", undefined, undefined],
    [" ".repeat(30), undefined, undefined],
    ["4 calls", "inactive", undefined],
  ]);
  const [mark, button, facts] = isNode(head) ? childrenOf(head) : [];
  const pieces = (line: unknown) => (isNode(line) ? (childrenOf(line) as Node[]).map((piece) => [textOf(piece), piece.props?.["color"], piece.props?.["backgroundColor"]]) : []);
  expect(pieces(mark)).toEqual([["◆ ", "green_FOR_SUBAGENTS_ONLY", undefined]]);
  expect(isNode(button) ? [button.props?.["key"], button.props?.["label"], button.props?.["plain"]] : []).toEqual([
    "open-a-1",
    `executor · Fix the heading parser${" ".repeat(12)}`,
    true,
  ]);
  expect(pieces(facts).filter(([text]) => String(text).trim() !== "")).toEqual([
    ["sonnet-5-5", "inactive", undefined],
    ["high", "inactive", undefined],
    ["    0s", "inactive", undefined],
  ]);
  const explore = await ui.find({ key: "tools-a-2" });
  expect(styled(explore).at(-1)).toEqual(["2 calls", "inactive", undefined]);
  expect(styled(await ui.find({ key: "lane-a-2" }))[0]).toEqual(["◆ ", "blue_FOR_SUBAGENTS_ONLY", undefined]);
  await ui.unmount();
});

test("the latest wave's finished agents keep their blocks under a Finished label, each saying what it said and how long it ran", async ($, on) => {
  const w = await threeAgents($, on);
  await w.clock.advance(12_000);
  await finish($, "a-2", "\nMapped 14 callers of the router.\nNone bypass the harness.");
  await w.clock.advance(3_000);
  await finish($, "a-3", "", "aborted");
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  expect(body(await ui.drawn()).slice(3)).toEqual([
    "executor              ◆ running     15s",
    "Fix the heading parser",
    "✶ Bash bun test src/parser.sp…  4 calls",
    "sonnet-5-5 · high · 4.5k · ~$0.02",
    " ",
    "Finished",
    "architect             ! stopped     15s",
    "Review the ledger design",
    "stopped",
    "sonnet-5-5 · high · 2.5k · ~$0.01",
    " ",
    "explorer                 ✓ done     12s",
    "Map the router callers",
    "Mapped 14 callers of the router.",
    "sonnet-5-5 · high · 2.5k · ~$0.01",
    " ",
    "d: Details  1 running · 2 finished · 9.5k tokens",
  ]);
  const done = await ui.find({ key: "done-a-2" });
  const [button, facts] = isNode(done) ? (childrenOf(done) as Node[]) : [];
  const colors = (line: Node | undefined) => (line === undefined ? [] : (childrenOf(line) as Node[]).map((piece) => [piece.props?.["color"], piece.hover?.["color"]]));
  expect([button?.props?.["key"], button?.props?.["label"], button?.props?.["dimColor"]]).toEqual(["open-a-2", "explorer", true]);
  expect(colors(facts)).toContainEqual(["success", "text"]);
  await ui.unmount();
});

test("an earlier wave's finished agents collapse to one dim line each, while the running wave keeps its blocks", async ($, on) => {
  const w = world(on, {});
  engine(on, {});
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "explorer", "Map the router callers", "Map them."));
  await finish($, "a-1", "Mapped 14 callers of the router.");
  await w.clock.advance(5_000);
  await $.agent.spawn(spawnOf(2, "executor", "Fix the heading parser", "Fix it."));
  w.agents = [{ id: "a-2", description: "", type: "x", status: "running" }];
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  const rows = body(await ui.drawn()).slice(3);
  expect(rows.slice(5, 7)).toEqual(["Finished", "✓ explorer · Mapped 14 callers of the rout…      0s"]);
  expect(await ui.find({ key: "lane-a-2" })).toBeDefined();
  await ui.unmount();
});

test("at the exact rows for one relaxed lane and two earlier finished agents, the Finished label keeps a row under it", async ($, on) => {
  const w = world(on, {});
  engine(on, {});
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "explorer", "One", "One."));
  await $.agent.spawn(spawnOf(2, "architect", "Two", "Two."));
  await finish($, "a-1", "First.");
  await finish($, "a-2", "Second.");
  await w.clock.advance(5_000);
  await $.agent.spawn(spawnOf(3, "executor", "Three", "Three."));
  w.agents = [{ id: "a-3", description: "", type: "x", status: "running" }];
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 16, placement: "dock" }));

  const rows = body(await ui.drawn());
  const label = rows.indexOf("Finished");
  expect(label).toBeGreaterThan(0);
  expect(rows[label + 1]).toStartWith("✓ ");
  await ui.unmount();
});

test("the pane timer ends each lane the agent list reports completed, failed or killed, in that status's glyph", async ($, on) => {
  const w = await threeAgents($, on);
  w.agents = [
    { id: "a-1", description: "", type: "x", status: "completed" },
    { id: "a-2", description: "", type: "x", status: "failed" },
    { id: "a-3", description: "", type: "x", status: "killed" },
  ];
  await w.clock.advance(2000);
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  const done = await Promise.all(["a-1", "a-2", "a-3"].map(async (id) => (await ui.find({ key: `done-${id}` }))?.text.trimEnd()));
  expect(done).toEqual(["executor                 ✓ done      2s", "explorer               ✗ failed      2s", "architect             ! stopped      2s"]);
  await ui.unmount();
});

test("hovering a lane reveals a card, drawn last so it paints over the rows below, with the masked prompt and last output", async ($, on) => {
  const w = world(on, {});
  engine(on, { "a-1": [{ uses: [{ name: "Read", input: { file_path: "/home/u/.env" } }], answer: "Read /home/u/.env\nIt holds token=s3cr3t-value here" }] });
  await $.command.run(run(""));
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";
  await $.agent.spawn(spawnOf(1, "executor", "Rotate the key", `Rotate the key ${secret} kept in /home/u/.env and confirm the service restarts cleanly afterwards.`));
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  await stepAll($, "a-1", 1);
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  const tree = await ui.drawn();
  const panel = nodeByKey(tree, "card-a-1");
  expect(panel === undefined ? undefined : { props: panel.props, hover: panel.hover }).toEqual({
    props: {
      key: "card-a-1",
      position: "absolute",
      top: -2,
      left: 2,
      width: 49,
      display: "none",
      flexDirection: "column",
      borderStyle: "round",
      borderColor: "green_FOR_SUBAGENTS_ONLY",
      backgroundColor: "userMessageBackground",
      paddingX: 1,
    },
    hover: { display: "flex", scope: "omca-agent-a-1" },
  });
  expect(nodeByKey(tree, "agent-a-1")?.hover).toEqual({ scope: "omca-agent-a-1" });
  const top = isNode(tree) ? childrenOf(tree) : [];
  expect(top.map((child) => (isNode(child) ? child.props?.["key"] : undefined)).at(-1)).toBe("agent-cards");
  expect(isNode(panel) ? childrenOf(panel).map(textOf) : []).toEqual([
    "executor · Rotate the key",
    "Prompt",
    "Rotate the key ‹masked› kept in ~/.env and",
    "confirm the service restarts cleanly",
    "afterwards.",
    "Last output",
    "It holds token=‹masked› here",
    "1 tool call · 1.5k tokens · 2 secrets masked…",
  ]);
  expect(JSON.stringify(await ui.drawn())).not.toContain("s3cr3t");
  expect(JSON.stringify(await ui.drawn())).not.toContain("abcdefghij");
  expect(body(await ui.drawn())[5]).toBe(spread("· Read ~/.env", "1 call", 39));
  await ui.unmount();
});

test("a card that cannot fit below its lane in a short inline body is pinned inside the body, with fewer prompt lines", async ($, on) => {
  await threeAgents($, on);
  const ui = await $.ui.mount(pane("terminal", INLINE_80));
  const tops = await Promise.all(["a-1", "a-2", "a-3"].map(async (id) => (await ui.find({ key: `card-${id}` }))?.props["top"]));
  expect(tops).toEqual([-5, -5, -5]);
  const panel = await ui.find({ key: "card-a-1" });
  expect(isNode(panel) ? childrenOf(panel).map(textOf) : []).toEqual([
    "executor · Fix the heading parser",
    "Prompt",
    "Fix the heading parser so fenced lines are skipped.",
    "Last output",
    "Found the heading rule.",
    "4 tool calls · 4.5k tokens · ~$0.02",
  ]);
  await ui.unmount();
});

test("a prompt is masked before it is cut, so a secret at the cut never shows in part", async ($, on) => {
  const w = world(on, {});
  engine(on, {});
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "executor", "Long", `${"word ".repeat(78)}sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 tail`));
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  const ui = await $.ui.mount(pane("terminal", DOCK_120));
  const drawn = JSON.stringify(await ui.drawn());
  expect(drawn).not.toContain("sk-ant");
  expect(drawn).not.toContain("abcdefghij");
  await ui.unmount();
});

test("d shows each running lane's prompt and last output under its usage, and d again hides them", async ($, on) => {
  const w = await threeAgents($, on);
  await finish($, "a-3", "The ledger holds.");
  w.agents = w.agents.slice(0, 2);
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  await ui.press({ key: "d" });
  expect(body(await ui.drawn()).slice(3)).toEqual([
    "executor              ◆ running      0s",
    "Fix the heading parser",
    "· Bash bun test src/parser.sp…  4 calls",
    "sonnet-5-5 · high · 4.5k · ~$0.02",
    "  prompt  Fix the heading parser so fe…",
    "  output  Found the heading rule.",
    " ",
    "explorer              ◆ running      0s",
    "Map the router callers",
    "· ast_search                    2 calls",
    "sonnet-5-5 · high · 3.0k · ~$0.01",
    "  prompt  Find every caller of the rou…",
    "  output  none yet",
    " ",
    "Finished",
    "architect                ✓ done      0s",
    "Review the ledger design",
    "The ledger holds.",
    "sonnet-5-5 · high · 2.5k · ~$0.01",
    "  prompt  Review the ledger rotation.",
    "  output  none yet",
    " ",
    "d: Hide details  2 running · 1 finished",
  ]);

  await ui.press({ key: "d" });
  expect(body(await ui.drawn()).at(-1)).toBe("d: Details  2 running · 1 finished · 10.0k tokens");
  expect(body(await ui.drawn())).not.toContain("  output  none yet");
  await ui.unmount();
});

test("the spinner and the elapsed clocks move once a second while an agent runs", async ($, on) => {
  const w = await threeAgents($, on);
  const ui = await $.ui.mount(pane("terminal", DOCK_COMPACT));
  const lane = async () => body(await ui.drawn()).slice(3, 5);
  const tools = (frame: string) => spread(`  ${frame} Bash bun test src/parser.spec.ts`, "4 calls");

  expect(await lane()).toEqual(["◆ executor · Fix the heading parser    high      0s", tools("·")]);
  await w.clock.advance(1000);
  expect(await lane()).toEqual(["◆ executor · Fix the heading parser    high      1s", tools("✢")]);
  await w.clock.advance(999);
  expect((await lane())[1]).toBe(tools("✢"));
  await w.clock.advance(1);
  expect(await lane()).toEqual(["◆ executor · Fix the heading parser    high      2s", tools("✳")]);
  await ui.unmount();
});

test("agents past the inline body are counted on one row, and the keys row stays", async ($, on) => {
  const w = world(on, {});
  engine(on, {});
  await $.command.run(run("", 80));
  for (let n = 1; n <= 6; n++) await $.agent.spawn(spawnOf(n, "executor", `Port module ${n}`, `Port module ${n}.`));
  await finish($, "a-6", "Ported.");
  w.agents = [1, 2, 3, 4, 5].map((n) => ({ id: `a-${n}`, description: "", type: "x", status: "running" }));
  const ui = await $.ui.mount(pane("terminal", INLINE_80));

  const rows = body(await ui.drawn());
  expect(rows.filter((row) => row.startsWith("  · starting"))).toHaveLength(4);
  expect(rows.slice(-2)).toEqual(["… 1 more running · 1 more finished", "d: Details  5 running · 1 finished · 2.5k tokens"]);
  expect(rows).toHaveLength(11);
  await ui.unmount();
});

test("parallel spawns and steps each keep their own lane", async ($, on) => {
  const w = world(on, {});
  engine(on, {
    "a-1": [{ uses: [{ name: "Read", input: { file_path: "/work/a.ts" } }] }],
    "a-2": [{ uses: [{ name: "Bash", input: { command: "just test" } }] }],
    "a-3": [{ uses: [{ name: "Edit", input: { file_path: "/work/c.ts" } }] }],
  });
  await $.command.run(run(""));
  await Promise.all([1, 2, 3].map((n) => $.agent.spawn(spawnOf(n, "executor", `Task ${n}`, `Task ${n}.`))));
  w.agents = [1, 2, 3].map((n) => ({ id: `a-${n}`, description: "", type: "x", status: "running" }));
  await Promise.all(["a-1", "a-2", "a-3"].map((id) => stepAll($, id, 1)));
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  const tools = await Promise.all(["a-1", "a-2", "a-3"].map(async (id) => textOf(await ui.find({ key: `tools-${id}` }))));
  expect(tools).toEqual([spread("· Read a.ts", "1 call", 39), spread("· Bash just test", "1 call", 39), spread("· Edit c.ts", "1 call", 39)]);
  expect(w.logs.filter((line) => line.startsWith("agentsTracker"))).toEqual([]);
  await ui.unmount();
});

test("a routed delegation's lane keeps the prompt without its routing line", async ($, on) => {
  const w = world(on, {});
  engine(on, {});
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "executor", "Port", "[omca-route effort=low]\nPort module 1."));
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  await $.ui.mount(pane("terminal", DOCK_120)).then(async (ui) => {
    await ui.press({ key: "d" });
    expect(body(await ui.drawn())).toContain("  prompt  Port module 1.");
    await ui.unmount();
  });
});

test("OMCA_GLYPHS=ascii draws the lanes and the spinner in ASCII", async ($, on) => {
  const w = world(on, {}, {}, { OMCA_GLYPHS: "ascii" });
  engine(on, STEPS);
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "executor", "Fix the heading parser", "Fix it."));
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  await stepAll($, "a-1", 3);
  const ui = await $.ui.mount(pane("terminal", INLINE_80));

  expect(body(await ui.drawn()).slice(1)).toEqual([
    `@ executor - Fix the heading parser${" ".repeat(14)}sonnet-5-5  high      0s`,
    spread("  | Bash bun test src/parser.spec.ts", "4 calls", 73),
    "d: Details  1 running - 0 finished - 4.5k tokens",
  ]);
  expect(body(await ui.drawn()).filter((row) => !isAscii(row))).toEqual([]);
  await ui.unmount();
});

test("by default each agent draws its own Nerd Font icon, a space after it", async ($, on) => {
  const w = world(on, {}, {}, { OMCA_GLYPHS: "" });
  engine(on, STEPS);
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "executor", "Fix the heading parser", "Fix it."));
  await $.agent.spawn(spawnOf(2, "architect", "Review the ledger design", "Review it."));
  w.agents = ["a-1", "a-2"].map((id) => ({ id, description: "", type: "x", status: "running" }));
  await finish($, "a-2", "The ledger holds.");
  w.agents = w.agents.slice(0, 1);
  const ui = await $.ui.mount(pane("terminal", DOCK_TINY));

  const rows = body(await ui.drawn()).slice(3);
  expect(rows[0]).toStartWith("\u{f085} executor · ");
  expect(rows[2]).toStartWith("\u{f05d} architect · The ledger holds.");
  await ui.unmount();
});

type AgentRow = { status: string; endedAt: number | null; teammate: boolean };

const atoms = new Map<string, { value: unknown; version: number }>();
const agentRows = async (): Promise<Record<string, AgentRow>> => (atoms.get("agents")?.value ?? {}) as Record<string, AgentRow>;

test("a teammate stays open and idle between turns, runs again on its next step, and follows the engine's listed status", async ($, on) => {
  atoms.clear();
  on("state.get", (_$, e) => ({ value: atoms.get(e.key) ?? { value: undefined, version: 0 } }));
  on("state.set", (_$, e) => {
    const version = (atoms.get(e.key)?.version ?? 0) + 1;
    atoms.set(e.key, { value: e.value, version });
    return { value: { isSet: true, version } };
  });
  const w = world(on, {});
  engine(on, {});
  await $.command.run(run(""));
  await $.agent.spawn({ ...spawnOf(1, "executor", "Teammate work", "Do it."), isTeammate: true });
  await $.agent.spawn(spawnOf(2, "explorer", "Subagent work", "Find it."));
  expect((await agentRows())["a-1"]).toMatchObject({ status: "running", endedAt: null, teammate: true });
  expect((await agentRows())["a-2"]).toMatchObject({ teammate: false });

  await finish($, "a-1", "Turn one.");
  await finish($, "a-2", "Done.");
  expect((await agentRows())["a-1"]).toMatchObject({ status: "idle", endedAt: null });
  expect((await agentRows())["a-2"]).toMatchObject({ status: "answer" });
  expect((await agentRows())["a-2"]?.endedAt).not.toBeNull();

  await stepAll($, "a-1", 1);
  expect((await agentRows())["a-1"]).toMatchObject({ status: "running", endedAt: null });

  w.agents = [{ id: "a-1", description: "", type: "x", status: "idle" }];
  await w.clock.advance(2000);
  expect((await agentRows())["a-1"]).toMatchObject({ status: "idle", endedAt: null });
  w.agents = [{ id: "a-1", description: "", type: "x", status: "waiting" }];
  await w.clock.advance(2000);
  expect((await agentRows())["a-1"]).toMatchObject({ status: "waiting", endedAt: null });
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  await w.clock.advance(2000);
  expect((await agentRows())["a-1"]).toMatchObject({ status: "running", endedAt: null });
  w.agents = [{ id: "a-1", description: "", type: "x", status: "killed" }];
  await w.clock.advance(2000);
  expect((await agentRows())["a-1"]).toMatchObject({ status: "aborted" });
});

test("an idle teammate draws its status mark and word with no spinner and is left out of the running count", async ($, on) => {
  world(on, {});
  engine(on, {});
  await $.command.run(run(""));
  await $.agent.spawn({ ...spawnOf(1, "executor", "Teammate work", "Do it."), isTeammate: true });
  await $.agent.spawn(spawnOf(2, "explorer", "Subagent work", "Find it."));
  await finish($, "a-1", "Turn one.");
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  const rows = body(await ui.drawn()).slice(3);
  expect(rows[0]).toBe("executor                 ○ idle      0s");
  expect(rows[2]).toBe("○ idle");
  expect(rows[7]).toBe("· starting");
  expect(rows.at(-1)).toBe("d: Details  1 running · 1 idle · 0 finished");
  await ui.unmount();
});

test("a running agent with no mascot keeps its icon in the mini's place and the same four rows", async ($, on) => {
  const w = world(on, {}, {}, { OMCA_GLYPHS: "unicode" });
  engine(on, {});
  await $.command.run(run(""));
  await $.agent.spawn({ ...spawnOf(1, "executor", "Survey the repo", "Survey it."), subagentType: "general-purpose" });
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  const tree = await ui.drawn();
  const [row] = childrenOf(nodeByKey(tree, "agent-a-1") as Node) as Node[];
  const [gutter] = row === undefined ? [] : (childrenOf(row) as Node[]);
  expect([gutter?.props?.["width"], textOf(gutter)]).toEqual([8, "◆"]);
  expect(await ui.find({ type: "Raster" })).toBeUndefined();
  expect(body(tree).slice(3, 5)).toEqual(["general-purpose       ◆ running      0s", "Survey the repo"]);
  await ui.unmount();
});

test("two priced steps add up on the lane as an approximate cost beside the token count", async ($, on) => {
  engine(on, { "a-1": [{ uses: [] }, { uses: [] }] });
  const w = world(on, {});
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "executor", "Price the steps", "Price the steps."));
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  await stepAll($, "a-1", 2);
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  expect(body(await ui.drawn())).toContain("sonnet-5-5 · high · 3.0k · ~$0.01");
  await ui.unmount();
});

test("a step whose model has no price drops the lane's cost and it stays dropped", async ($, on) => {
  engine(on, { "a-1": [{ uses: [] }, { uses: [] }] }, "claude-mystery-1");
  const w = world(on, {});
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "executor", "Price the steps", "Price the steps."));
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  await stepAll($, "a-1", 2);
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  expect(body(await ui.drawn())).toContain("sonnet-5-5 · high · 3.0k tokens");
  await ui.unmount();
});
