import type { On, RenderElement, TurnStepToolUse } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { childrenOf, drain, isAscii, isNode, type Node, nodeByKey, pane, run, type Size, usage, world } from "./world.ts";

const DOCK_120: Size = { columns: 120, rows: 40, placement: "dock" };
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
function engine(on: On, steps: Readonly<Record<string, readonly Step[]>>): void {
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
      usage: usage(1200, 300),
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

function textOf(element: unknown): string {
  if (typeof element === "string") return element;
  if (!isNode(element) || isCard(element)) return "";
  if (element.type === "Button") return `${String(element.props?.["hotkey"])}: ${String(element.props?.["label"])}`;
  const gap = " ".repeat(typeof element.props?.["columnGap"] === "number" ? element.props["columnGap"] : 0);
  return childrenOf(element).map(textOf).join(element.type === "Box" ? gap : "");
}

/** The body rows as the terminal stacks them: a lane's anchor rows each on their own, its hover card left out. */
function body(tree: RenderElement): string[] {
  const top = isNode(tree) ? childrenOf(tree) : [];
  return top.flatMap((child) =>
    isNode(child) && child.type === "Box" && child.props?.["flexDirection"] === "column" ? childrenOf(child).filter((one) => !(isNode(one) && isCard(one))).map(textOf) : [textOf(child)],
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
  await $.agent.spawn(spawnOf(2, "explore", "Map the router callers", "Find every caller of the router."));
  await $.agent.spawn(spawnOf(3, "oracle", "Review the ledger design", "Review the ledger rotation."));
  w.agents = ["a-1", "a-2", "a-3"].map((id) => ({ id, description: "", type: "x", status: "running" }));
  await stepAll($, "a-1", 3);
  await stepAll($, "a-2", 2);
  await stepAll($, "a-3", 1);
  return w;
}

test("each running agent gets a lane: identity, task, chips, tokens and elapsed, then its tool strip and current tool", async ($, on) => {
  const w = await threeAgents($, on);
  await w.clock.advance(66_000);
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  expect(body(await ui.drawn()).slice(3)).toEqual([
    "◆ 3 running · 0 finished · 9.0k tokens",
    "◆ executor · Fix the heading pa…  high  4.5k  1m06s",
    "  ○○✎$ ◑ Bash bun test src/parser.spec.ts",
    "◆ explore · Map the router call…  high  3.0k  1m06s",
    "  ○◇ ◑ ast_search",
    "◆ oracle · Review the ledger de…  high  1.5k  1m06s",
    "  ○ ◑ Read plans/p.md",
    "d: Details   ○ read ✎ edit $ bash ◇ mcp ◆ agent",
  ]);
  await ui.unmount();
});

test("the lane widens with the body, keeping the model chip, at 80 and 200 columns", async ($, on) => {
  const w = await threeAgents($, on);
  await stepAll($, "a-3", 1);
  await w.clock.advance(66_000);

  const at80 = await $.ui.mount(pane("terminal", INLINE_80));
  expect(body(await at80.drawn()).slice(1, 4)).toEqual([
    "◆ 3 running · 0 finished · 10.5k tokens",
    "◆ executor · Fix the heading parser        sonnet-5-5   high  4.5k  1m06s",
    "  ○○✎$ ◑ Bash bun test src/parser.spec.ts",
  ]);
  await at80.unmount();

  const at200 = await $.ui.mount(pane("terminal", INLINE_200));
  const rows = body(await at200.drawn());
  expect(rows[2]).toBe(`◆ executor · Fix the heading parser${" ".repeat(128)}sonnet-5-5   high  4.5k  1m06s`);
  expect(rows.at(-1)).toBe("d: Details   ○ read ✎ edit $ bash ◇ mcp ◆ agent");
  await at200.unmount();
});

test("tool calls draw one glyph each in their kind's key, the current tool's name in text, identity in its key and the clock muted", async ($, on) => {
  await threeAgents($, on);
  const ui = await $.ui.mount(pane("terminal", INLINE_80));
  const lane = await ui.find({ key: "tools-a-1" });
  const head = await ui.find({ key: "lane-a-1" });
  const styled = (node: unknown): [string, unknown, unknown][] =>
    isNode(node) ? (childrenOf(childrenOf(node)[0] as Node) as Node[]).map((piece) => [textOf(piece), piece.props?.["color"], piece.props?.["backgroundColor"]]) : [];

  expect(styled(lane)).toEqual([
    ["  ", undefined, undefined],
    ["○○", "rainbow_blue", undefined],
    ["✎", "rainbow_violet", undefined],
    ["$", "rainbow_orange", undefined],
    [" ", undefined, undefined],
    ["◐", "claude", undefined],
    [" ", undefined, undefined],
    ["Bash", "text", undefined],
    [" bun test src/parser.spec.ts", undefined, undefined],
  ]);
  expect(styled(head).filter(([text]) => text.trim() !== "")).toEqual([
    ["◆ ", "green_FOR_SUBAGENTS_ONLY", undefined],
    ["executor", "green_FOR_SUBAGENTS_ONLY", undefined],
    [" · Fix the heading parser      ", undefined, undefined],
    [" sonnet-5-5 ", "inverseText", "permission"],
    [" high ", "inverseText", "inactive"],
    ["4.5k", "inactive", undefined],
    ["    0s", "inactive", undefined],
  ]);
  const explore = await ui.find({ key: "tools-a-2" });
  expect(styled(explore).find(([text]) => text === "◇")).toEqual(["◇", "rainbow_indigo", undefined]);
  expect(styled(await ui.find({ key: "lane-a-2" }))[0]).toEqual(["◆ ", "blue_FOR_SUBAGENTS_ONLY", undefined]);
  await ui.unmount();
});

test("a finished agent collapses to one dim line with its result and duration, after the running lanes", async ($, on) => {
  const w = await threeAgents($, on);
  await w.clock.advance(12_000);
  await finish($, "a-2", "\nMapped 14 callers of the router.\nNone bypass the harness.");
  await w.clock.advance(3_000);
  await finish($, "a-3", "", "aborted");
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  expect(body(await ui.drawn()).slice(3)).toEqual([
    "◆ 1 running · 2 finished · 9.5k tokens",
    "◆ executor · Fix the heading pa…  high  4.5k    15s",
    "  ○○✎$ ◒ Bash bun test src/parser.spec.ts",
    "! oracle · stopped                              15s",
    "✓ explore · Mapped 14 callers of the router.    12s",
    "d: Details   ○ read ✎ edit $ bash ◇ mcp ◆ agent",
  ]);
  const done = await ui.find({ key: "done-a-2" });
  const pieces = isNode(done) ? (childrenOf(childrenOf(done)[0] as Node) as Node[]) : [];
  expect(pieces.map((piece) => [piece.props?.["color"], piece.hover?.["color"]])).toEqual([
    ["success", "text"],
    ["inactive", "text"],
    ["inactive", "text"],
  ]);
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
  expect(done).toEqual([
    "✓ executor · done                                2s",
    "✗ explore · failed                               2s",
    "! oracle · stopped                               2s",
  ]);
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
      top: -1,
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
    "1 tool call · 2 masked",
  ]);
  expect(JSON.stringify(await ui.drawn())).not.toContain("s3cr3t");
  expect(JSON.stringify(await ui.drawn())).not.toContain("abcdefghij");
  expect(body(await ui.drawn())[5]).toBe("  ○ ◐ Read ~/.env");
  await ui.unmount();
});

test("a card that cannot fit below its lane in a short inline body is pinned inside the body, with fewer prompt lines", async ($, on) => {
  await threeAgents($, on);
  const ui = await $.ui.mount(pane("terminal", INLINE_80));
  const tops = await Promise.all(["a-1", "a-2", "a-3"].map(async (id) => (await ui.find({ key: `card-${id}` }))?.props["top"]));
  expect(tops).toEqual([-6, -6, -6]);
  const panel = await ui.find({ key: "card-a-1" });
  expect(isNode(panel) ? childrenOf(panel).map(textOf) : []).toEqual([
    "executor · Fix the heading parser",
    "Prompt",
    "Fix the heading parser so fenced lines are skipped.",
    "Last output",
    "Found the heading rule.",
    "4 tool calls",
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

test("d shows each running lane's prompt and last output under it, and d again hides them", async ($, on) => {
  const w = await threeAgents($, on);
  await finish($, "a-3", "The ledger holds.");
  w.agents = w.agents.slice(0, 2);
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  await ui.press({ key: "d" });
  expect(body(await ui.drawn()).slice(4)).toEqual([
    "◆ executor · Fix the heading pa…  high  4.5k     0s",
    "  ○○✎$ ◐ Bash bun test src/parser.spec.ts",
    "  prompt Fix the heading parser so fenced lines ar…",
    "  output Found the heading rule.",
    "◆ explore · Map the router call…  high  3.0k     0s",
    "  ○◇ ◐ ast_search",
    "  prompt Find every caller of the router.",
    "  output none yet",
    "✓ oracle · The ledger holds.                     0s",
    "d: Hide details   ○ read ✎ edit $ bash ◇ mcp",
  ]);

  await ui.press({ key: "d" });
  expect(body(await ui.drawn()).at(-1)).toBe("d: Details   ○ read ✎ edit $ bash ◇ mcp ◆ agent");
  expect(body(await ui.drawn())).not.toContain("  output none yet");
  await ui.unmount();
});

test("the spinner and the elapsed clocks move once a second while an agent runs", async ($, on) => {
  const w = await threeAgents($, on);
  const ui = await $.ui.mount(pane("terminal", DOCK_120));
  const lane = async () => body(await ui.drawn()).slice(4, 6);

  expect(await lane()).toEqual(["◆ executor · Fix the heading pa…  high  4.5k     0s", "  ○○✎$ ◐ Bash bun test src/parser.spec.ts"]);
  await w.clock.advance(1000);
  expect(await lane()).toEqual(["◆ executor · Fix the heading pa…  high  4.5k     1s", "  ○○✎$ ◓ Bash bun test src/parser.spec.ts"]);
  await w.clock.advance(999);
  expect((await lane())[1]).toBe("  ○○✎$ ◓ Bash bun test src/parser.spec.ts");
  await w.clock.advance(1);
  expect(await lane()).toEqual(["◆ executor · Fix the heading pa…  high  4.5k     2s", "  ○○✎$ ◑ Bash bun test src/parser.spec.ts"]);
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
  expect(rows.slice(1, 2)).toEqual(["◆ 5 running · 1 finished · 2.5k tokens"]);
  expect(rows.filter((row) => row.startsWith("  ◐ starting"))).toHaveLength(3);
  expect(rows.slice(-2)).toEqual(["… 2 more running · 1 more finished", "d: Details   ○ read ✎ edit $ bash ◇ mcp ◆ agent"]);
  expect(rows).toHaveLength(10);
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
  expect(tools).toEqual(["  ○ ◐ Read a.ts", "  $ ◐ Bash just test", "  ✎ ◐ Edit c.ts"]);
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
    expect(body(await ui.drawn())).toContain("  prompt Port module 1.");
    await ui.unmount();
  });
});

test("OMCA_ASCII draws the lanes, strip, spinner and chips in ASCII", async ($, on) => {
  const w = world(on, {}, {}, { OMCA_ASCII: "1" });
  engine(on, STEPS);
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "executor", "Fix the heading parser", "Fix it."));
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  await stepAll($, "a-1", 3);
  const ui = await $.ui.mount(pane("terminal", INLINE_80));

  expect(body(await ui.drawn()).slice(1)).toEqual([
    "@ 1 running - 0 finished - 4.5k tokens",
    "@ executor - Fix the heading parser       [sonnet-5-5] [high] 4.5k     0s",
    "  rre$ | Bash bun test src/parser.spec.ts",
    "d: Details   r read e edit $ bash m mcp @ agent",
  ]);
  expect(body(await ui.drawn()).filter((row) => !isAscii(row))).toEqual([]);
  await ui.unmount();
});
