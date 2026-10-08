import type { On, RenderElement, TurnStepToolUse } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { childrenOf, drain, isAscii, isNode, lineCodeOf, type Node, nodeByKey, pane, run, type Size, usage, world } from "./world.ts";

const DOCK_120: Size = { columns: 120, rows: 40, placement: "dock" };
// A body of 11 rows: too short for three relaxed lanes, and for one relaxed lane with a finished one under it.
const DOCK_COMPACT: Size = { columns: 120, rows: 16, placement: "dock" };
// A body of 6 rows.
const DOCK_TINY: Size = { columns: 120, rows: 11, placement: "dock" };
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
  const line = lineCodeOf(element);
  if (line !== undefined) return line;
  if (element.type === "Button") return typeof element.props?.["hotkey"] === "string" ? `${element.props["hotkey"]}: ${String(element.props["label"])}` : String(element.props?.["label"]);
  const gap = " ".repeat(typeof element.props?.["columnGap"] === "number" ? element.props["columnGap"] : 0);
  return childrenOf(element).map(textOf).join(element.type === "Box" ? gap : "");
}

// A relaxed lane is a row of its mini and a column of its rows; the mini draws no text, so only the rows count.
const blockRows = (node: unknown): string[] => {
  const [, column] = isNode(node) && node.type === "Box" && node.props?.["flexDirection"] === "row" ? childrenOf(node) : [];
  return isNode(column) && column.props?.["flexDirection"] === "column" ? childrenOf(column).map(textOf) : [textOf(node)];
};

const isChrome = (child: unknown) => isNode(child) && (String(child.props?.["key"]).startsWith("tabs-") || /^[─-]+$/.test(textOf(child)));

/** The tab's rows as the terminal stacks them, under the tab bar and its rule: a lane's hover card left out, a lane's anchor rows each on their own, a relaxed lane's rows without its mini. */
function body(tree: RenderElement): string[] {
  const top = (isNode(tree) ? childrenOf(tree) : []).filter((child) => !isChrome(child));
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

  expect(body(await ui.drawn())).toEqual([
    "◆ executor · Fix the heading parser    high   1m06s",
    spread("  · Bash bun test src/parser.spec.ts", "4 calls"),
    " ",
    "◆ explorer · Map the router callers    high   1m06s",
    spread("  · ast_search", "2 calls"),
    " ",
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
  expect(body(await at80.drawn()).slice(0, 2)).toEqual([
    "◆ executor · Fix the heading parser              sonnet-5-5  high   1m06s",
    spread("  · Bash bun test src/parser.spec.ts", "4 calls", 73),
  ]);
  await at80.unmount();

  const at200 = await $.ui.mount(pane("terminal", INLINE_200));
  const rows = body(await at200.drawn());
  expect(rows[0]).toBe(`◆ executor · Fix the heading parser${" ".repeat(134)}sonnet-5-5  high   1m06s`);
  expect(rows.at(-1)).toBe("d: Details  3 running · 0 finished · 10.5k tokens");
  await at200.unmount();
});

test("the current tool's name draws in text with the call count muted at the right edge, the identity glyph in its key, the name in text and the columns muted", async ($, on) => {
  await threeAgents($, on);
  const ui = await $.ui.mount(pane("terminal", INLINE_80));
  const lane = await ui.find({ key: "tools-a-1" });
  const head = await ui.find({ key: "lane-a-1" });
  const styled = (line: unknown): [string, unknown, unknown][] =>
    isNode(line) ? (childrenOf(line) as Node[]).map((piece) => [textOf(piece), piece.props?.["color"], piece.props?.["backgroundColor"]]) : [];
  const rowPieces = (row: unknown) => styled(isNode(row) ? childrenOf(row)[0] : undefined);
  const [lead, command, tail] = isNode(lane) ? childrenOf(lane) : [];

  expect(styled(lead)).toEqual([
    ["  ", undefined, undefined],
    ["·", "claude", undefined],
    [" ", undefined, undefined],
    ["Bash", "text", undefined],
    [" ", undefined, undefined],
  ]);
  expect(isNode(command) ? [command.props?.["width"], (childrenOf(command)[0] as Node).props] : []).toEqual([
    55,
    { source: "bun test src/parser.spec.ts", language: "bash", wrap: "truncate-end" },
  ]);
  expect(styled(tail)).toEqual([
    ["  ", undefined, undefined],
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
  expect(rowPieces(explore).at(-1)).toEqual(["2 calls", "inactive", undefined]);
  expect(rowPieces(await ui.find({ key: "lane-a-2" }))[0]).toEqual(["◆ ", "blue_FOR_SUBAGENTS_ONLY", undefined]);
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

  expect(body(await ui.drawn())).toEqual([
    "executor        ◆ running     15s",
    "Fix the heading parser",
    "✶ Bash bun test src/par…  4 calls",
    "sonnet-5-5 · high · 4.5k · ~$0.02",
    "Finished",
    "architect       ! stopped     15s",
    "Review the ledger design",
    "stopped",
    "sonnet-5-5 · high · 2.5k · ~$0.01",
    " ",
    "explorer        ✓ done        12s",
    "Map the router callers",
    "Mapped 14 callers of the router.",
    "sonnet-5-5 · high · 2.5k · ~$0.01",
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

  const rows = body(await ui.drawn());
  expect(rows.slice(4, 6)).toEqual(["Finished", "✓ explorer · Map the router callers · Mapp…      0s"]);
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
  // A body of 8 rows: the block, the label, a finished row and the keys row, with a second finished row.
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 13, placement: "dock" }));

  const rows = body(await ui.drawn());
  const label = rows.indexOf("Finished");
  expect(label).toBeGreaterThan(0);
  expect(rows[label + 1]).toStartWith("✓ ");
  await ui.unmount();

  const compact = await $.ui.mount(pane("terminal", { columns: 120, rows: 12, placement: "dock" }));
  expect(body(await compact.drawn())).not.toContain("Finished");
  expect(await compact.find({ key: "lane-a-3" })).toBeDefined();
  await compact.unmount();
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
  expect(done).toEqual(["executor        ✓ done         2s", "explorer        ✗ failed       2s", "architect       ! stopped      2s"]);
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
    "1 tool call · 1.5k tokens · 2 secrets masked…",
  ]);
  expect(JSON.stringify(await ui.drawn())).not.toContain("s3cr3t");
  expect(JSON.stringify(await ui.drawn())).not.toContain("abcdefghij");
  expect(body(await ui.drawn())[2]).toBe(spread("· Read ~/.env", "1 call", 33));
  await ui.unmount();
});

test("a card that cannot fit below its lane in a short inline body is pinned inside the body, with fewer prompt lines", async ($, on) => {
  await threeAgents($, on);
  const ui = await $.ui.mount(pane("terminal", INLINE_80));
  const tops = await Promise.all(["a-1", "a-2", "a-3"].map(async (id) => (await ui.find({ key: `card-${id}` }))?.props["top"]));
  expect(tops).toEqual([-7, -7, -7]);
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

test("d shows each running block's prompt and last output and a finished block's prompt alone, labels at the text column, and d again hides them", async ($, on) => {
  const w = await threeAgents($, on);
  await finish($, "a-3", "The ledger holds.");
  w.agents = w.agents.slice(0, 2);
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  await ui.press({ key: "d" });
  expect(body(await ui.drawn())).toEqual([
    "executor        ◆ running      0s",
    "Fix the heading parser",
    "· Bash bun test src/par…  4 calls",
    "sonnet-5-5 · high · 4.5k · ~$0.02",
    "prompt  Fix the heading parser so",
    "        fenced lines are skipped.",
    "output  Found the heading rule.",
    " ",
    "explorer        ◆ running      0s",
    "Map the router callers",
    "· ast_search              2 calls",
    "sonnet-5-5 · high · 3.0k · ~$0.01",
    "prompt  Find every caller of the",
    "        router.",
    "output  none yet",
    "Finished",
    "architect       ✓ done         0s",
    "Review the ledger design",
    "The ledger holds.",
    "sonnet-5-5 · high · 2.5k · ~$0.01",
    "prompt  Review the ledger",
    "        rotation.",
    "d: Hide details  2 running · 1 finished",
  ]);

  await ui.press({ key: "d" });
  expect(body(await ui.drawn()).at(-1)).toBe("d: Details  2 running · 1 finished · 10.0k tokens");
  expect(body(await ui.drawn())).not.toContain("output  none yet");
  await ui.unmount();
});

test("the spinner and the elapsed clocks move once a second while an agent runs", async ($, on) => {
  const w = await threeAgents($, on);
  const ui = await $.ui.mount(pane("terminal", DOCK_COMPACT));
  const lane = async () => body(await ui.drawn()).slice(0, 2);
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

test("agents past the inline body are counted on one row below the lanes, and the keys row stays", async ($, on) => {
  const w = world(on, {});
  engine(on, {});
  await $.command.run(run("", 80));
  for (let n = 1; n <= 6; n++) await $.agent.spawn(spawnOf(n, "executor", `Port module ${n}`, `Port module ${n}.`));
  await finish($, "a-6", "Ported.");
  w.agents = [1, 2, 3, 4, 5].map((n) => ({ id: `a-${n}`, description: "", type: "x", status: "running" }));
  const ui = await $.ui.mount(pane("terminal", INLINE_80));

  const rows = body(await ui.drawn());
  expect(rows.filter((row) => row.startsWith("  · starting"))).toHaveLength(4);
  expect(rows.slice(-3)).toEqual(["↓ 2 more", "d: Details  5 running · 1 finished · 2.5k tokens", " "]);
  expect(rows).toHaveLength(11);
  await ui.unmount();
});

const SCROLL = { component: "Pane", requestId: "omca", offset: 0, origin: { kind: "person" }, pointer: { column: 4, row: 6 }, bodyRows: 15, contentRows: 16 } as const;

test("the wheel brings the lanes below the body into view and back, the cues counting the lanes hidden on each side", async ($, on) => {
  const w = world(on, {});
  engine(on, {});
  await $.command.run(run(""));
  for (let n = 1; n <= 8; n++) await $.agent.spawn(spawnOf(n, "executor", `Port module ${n}`, `Port module ${n}.`));
  w.agents = Array.from({ length: 8 }, (_, n) => ({ id: `a-${n + 1}`, description: "", type: "x", status: "running" }));
  const ui = await $.ui.mount(pane("terminal", DOCK_COMPACT));
  const tick = (by: number) => $.ui.scroll({ ...SCROLL, by });
  const view = async () => {
    const rows = body(await ui.drawn());
    return {
      lanes: rows.filter((row) => row.startsWith("◆ ")).map((row) => row.slice(13, 26).trim()),
      cues: rows.filter((row) => /^[↑↓] \d+ more$/.test(row)),
      rows: rows.length,
    };
  };
  const names = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, n) => `Port module ${from + n}`);

  expect(await view()).toEqual({ lanes: names(1, 4), cues: ["↓ 4 more"], rows: 12 });
  await tick(1);
  expect(await view()).toEqual({ lanes: names(2, 5), cues: ["↑ 1 more", "↓ 3 more"], rows: 12 });
  await tick(9);
  expect(await view()).toEqual({ lanes: names(5, 8), cues: ["↑ 4 more"], rows: 12 });
  await tick(1);
  expect((await view()).cues).toEqual(["↑ 4 more"]);
  await tick(-1);
  expect(await view()).toEqual({ lanes: names(4, 7), cues: ["↑ 3 more", "↓ 1 more"], rows: 12 });
  await tick(-9);
  expect(await view()).toEqual({ lanes: names(1, 4), cues: ["↓ 4 more"], rows: 12 });
  await ui.unmount();
});

test("with lanes hidden, the keys step the focus a lane at a time and the window follows it", async ($, on) => {
  const w = world(on, {});
  engine(on, {});
  await $.command.run(run(""));
  for (let n = 1; n <= 8; n++) await $.agent.spawn(spawnOf(n, "executor", `Port module ${n}`, `Port module ${n}.`));
  w.agents = Array.from({ length: 8 }, (_, n) => ({ id: `a-${n + 1}`, description: "", type: "x", status: "running" }));
  const ui = await $.ui.mount(pane("terminal", DOCK_COMPACT));
  const { pointer: _pointer, ...keys } = SCROLL;
  const key = (by: number) => $.ui.scroll({ ...keys, by });
  const lanes = async () => body(await ui.drawn()).filter((row) => row.startsWith("◆ ")).map((row) => Number(row.slice(13, 26).trim().replace("Port module ", "")));

  await $.ui.focus({ component: "Pane", requestId: "omca", element: "open-a-4", origin: { kind: "person" } });
  await key(1);
  expect(await lanes()).toEqual([2, 3, 4, 5]);
  await key(-1);
  await key(-1);
  await key(-1);
  expect(await lanes()).toEqual([2, 3, 4, 5]);
  await key(-1);
  expect(await lanes()).toEqual([1, 2, 3, 4]);
  await key(SCROLL.contentRows);
  expect(await lanes()).toEqual([5, 6, 7, 8]);
  await key(-SCROLL.contentRows);
  expect(await lanes()).toEqual([1, 2, 3, 4]);
  await ui.unmount();
});

test("a relaxed lane is one stop: its head is the only Button, its task is text, and the first lane's head takes the ring", async ($, on) => {
  const w = world(on, {});
  engine(on, {});
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "executor", "Fix the heading parser", "Fix it."));
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  const ui = await $.ui.mount(pane("terminal", DOCK_120));
  expect(await ui.find({ key: "open-a-1-task" })).toBeUndefined();
  const head = await ui.find({ key: "open-a-1" });
  expect([head?.type, head?.props["label"], head?.props["plain"], head?.props["autoFocus"]]).toEqual(["Button", "executor", true, true]);
  expect(body(await ui.drawn())[1]).toBe("Fix the heading parser");

  await ui.press({ key: "open-a-1" });
  expect(await ui.find({ key: "page-header" })).toBeDefined();
  expect(await ui.find({ key: "lane-a-1" })).toBeUndefined();
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
  expect(tools).toEqual([spread("· Read a.ts", "1 call", 33), spread("· Bash just test", "1 call", 33), spread("· Edit c.ts", "1 call", 33)]);
  expect(w.logs.filter((line) => line.startsWith("agentsTracker"))).toEqual([]);
  await ui.unmount();
});

test("twelve agents spawned at once each keep their row and their place in the count", async ($, on) => {
  const w = world(on, {});
  const ids = Array.from({ length: 12 }, (_, n) => `a-${n + 1}`);
  engine(on, Object.fromEntries(ids.map((id) => [id, [{ uses: [{ name: "Read", input: { file_path: `/work/${id}.ts` } }] }]])));
  await $.command.run(run(""));
  await Promise.all(ids.map((_, n) => $.agent.spawn(spawnOf(n + 1, "executor", `Task ${n + 1}`, `Task ${n + 1}.`))));
  w.agents = ids.map((id) => ({ id, description: "", type: "x", status: "running" }));
  await Promise.all(ids.map((id) => stepAll($, id, 1)));

  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  expect(body(await ui.drawn()).find((row) => row.startsWith("d: Details"))).toStartWith("d: Details  12 running · 0 finished");
  expect(w.logs.filter((line) => line.startsWith("agentsTracker"))).toEqual([]);
  await ui.unmount();
});

test("OMCA_GLYPHS=ascii draws relaxed blocks in ASCII, the agent's glyph in a one-cell gutter in place of the mini", async ($, on) => {
  const w = world(on, {}, {}, { OMCA_GLYPHS: "ascii" });
  engine(on, STEPS);
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "executor", "Fix the heading parser", "Fix it."));
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];
  await stepAll($, "a-1", 3);
  const ui = await $.ui.mount(pane("terminal", INLINE_80));

  const tree = await ui.drawn();
  const [row] = childrenOf(nodeByKey(tree, "agent-a-1") as Node) as Node[];
  const [gutter] = row === undefined ? [] : (childrenOf(row) as Node[]);
  expect([gutter?.props?.["width"], textOf(gutter)]).toEqual([1, "@"]);
  expect(await ui.find({ type: "Raster" })).toBeUndefined();
  expect(body(tree)).toEqual([
    `executor${" ".repeat(44)}@ running      0s`,
    "Fix the heading parser",
    spread("| Bash bun test src/parser.spec.ts", "4 calls", 69),
    "sonnet-5-5 - high - 4.5k tokens - ~$0.02",
    "d: Details  1 running - 0 finished - 4.5k tokens",
  ]);
  expect(body(tree).filter((row) => !isAscii(row))).toEqual([]);
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

  const rows = body(await ui.drawn());
  expect(rows[0]).toStartWith("\u{f085} executor · ");
  expect(rows[2]).toStartWith("\u{f05d} architect · Review the ledger design · T…");
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

  const rows = body(await ui.drawn());
  expect(rows[0]).toBe("executor        ○ idle         0s");
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
  expect([gutter?.props?.["width"], textOf(gutter)]).toEqual([15, "◆"]);
  expect(await ui.find({ type: "Raster" })).toBeUndefined();
  expect(body(tree).slice(0, 2)).toEqual(["general-purpose         ◆      0s", "Survey the repo"]);
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

const running = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a-${i + 1}`, description: "", type: "x", status: "running" as const }));

async function sevenStarting($: Engine, on: On) {
  const w = world(on, {});
  engine(on, {});
  await $.command.run(run(""));
  for (let n = 1; n <= 7; n++) await $.agent.spawn(spawnOf(n, "executor", `Port module ${n}`, `Port module ${n}.`));
  w.agents = running(7);
  return w;
}

test("seven relaxed lanes fit a body of 35 rows: a blank between neighbours and none after the last, which the keys row follows", async ($, on) => {
  await sevenStarting($, on);
  // The tab bar and its rule take 2 of 37 body rows.
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 41, placement: "dock" }));

  const rows = body(await ui.drawn());
  expect(rows).toHaveLength(35);
  expect(rows.filter((row) => row === " ")).toHaveLength(6);
  expect(rows.slice(-5)).toEqual([
    "executor        ◆ running      0s",
    "Port module 7",
    "· starting",
    "sonnet-5-5",
    "d: Details  7 running · 0 finished · 0 tokens",
  ]);
  expect(rows.slice(0, 6)).toEqual(["executor        ◆ running      0s", "Port module 1", "· starting", "sonnet-5-5", " ", "executor        ◆ running      0s"]);
  expect(await ui.find({ type: "Raster" })).toBeDefined();
  await ui.unmount();

  const short = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  expect(await short.find({ type: "Raster" })).toBeUndefined();
  expect(await short.find({ key: "lane-a-7" })).toBeDefined();
  await short.unmount();
});

test("compact lanes with rows to spare keep a blank between running lanes, and none when the rows run out", async ($, on) => {
  await sevenStarting($, on);
  const spaced = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  const rows = body(await spaced.drawn());
  expect(rows.filter((row) => row === " ")).toHaveLength(6);
  expect(rows.at(-1)).toStartWith("d: Details  7 running");
  expect(rows.slice(0, 3).map((row) => row.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual(["◆ executor ·", "· starting", ""]);
  await spaced.unmount();

  const tight = await $.ui.mount(pane("terminal", { columns: 120, rows: 24, placement: "dock" }));
  expect(body(await tight.drawn()).filter((row) => row === " ")).toEqual([]);
  await tight.unmount();
});

test("a lane that has reported no usage shows no token count and no cost", async ($, on) => {
  await sevenStarting($, on);
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 41, placement: "dock" }));

  const rows = body(await ui.drawn());
  expect(rows.some((row) => row.includes("tokens") && !row.startsWith("d:"))).toBe(false);
  expect(rows.some((row) => row.includes("$"))).toBe(false);
  await ui.unmount();
});

test("a lane that overfills the body sheds its usage, then its output, then its prompt, before the cue or the keys row go", async ($, on) => {
  await threeAgents($, on);
  const shown = async (size: Size) => {
    const ui = await $.ui.mount(pane("terminal", size));
    await ui.press({ key: "d" });
    const rows = body(await ui.drawn());
    await ui.press({ key: "d" });
    await ui.unmount();
    return rows;
  };

  // A body of 6 rows: the lane's head and tool, two detail rows, the cue and the keys row.
  expect(await shown({ columns: 120, rows: 11, placement: "dock" })).toEqual([
    "◆ executor · Fix the heading parser    high      0s",
    spread("  · Bash bun test src/parser.spec.ts", "4 calls"),
    "  prompt  Fix the heading parser so fenced lines a…",
    "  output  Found the heading rule.",
    "↓ 2 more",
    "d: Hide details  3 running · 0 finished",
    " ",
  ]);
  // A body of 5 rows keeps only the prompt.
  expect(await shown({ columns: 120, rows: 10, placement: "dock" })).toEqual([
    "◆ executor · Fix the heading parser    high      0s",
    spread("  · Bash bun test src/parser.spec.ts", "4 calls"),
    "  prompt  Fix the heading parser so fenced lines a…",
    "↓ 2 more",
    "d: Hide details  3 running · 0 finished",
    " ",
  ]);
});

test("spare rows wrap a block's task and result to two lines, and its details prompt to three, once there are as many as blocks", async ($, on) => {
  const w = world(on, {});
  engine(on, {});
  await $.command.run(run(""));
  const task = "Port the incremental lexer onto the shared token stream and keep every fixture";
  await $.agent.spawn(spawnOf(1, "executor", task, `${task}. Then run the whole suite and report every failure that remains in the tree.`));
  await $.agent.spawn(spawnOf(2, "explorer", "Map the router callers", "Map."));
  await finish($, "a-2", `${task} and say what is left.`);
  w.agents = running(1);
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  expect(body(await ui.drawn())).toEqual([
    "executor        ◆ running      0s",
    "Port the incremental lexer onto",
    "the shared token stream and keep…",
    "· starting",
    "sonnet-5-5",
    "Finished",
    "explorer        ✓ done         0s",
    "Map the router callers",
    "Port the incremental lexer onto",
    "the shared token stream and keep…",
    "sonnet-5-5 · 2.5k tokens · ~$0.00",
    "d: Details  1 running · 1 finished · 2.5k tokens",
  ]);
  await ui.press({ key: "d" });
  expect(body(await ui.drawn()).slice(5, 9)).toEqual(["prompt  Port the incremental", "        lexer onto the shared", "        token stream and keep…", "output  none yet"]);
  await ui.press({ key: "d" });
  await ui.unmount();

  // Two blocks and one spare row: fewer than the blocks, so nothing wraps.
  const tight = await $.ui.mount(pane("terminal", { columns: 120, rows: 16, placement: "dock" }));
  expect(body(await tight.drawn()).filter((row) => row.startsWith("the shared"))).toEqual([]);
  await tight.unmount();
});

test("the compact head drops the model column before it cuts a task", async ($, on) => {
  const w = world(on, {});
  engine(on, STEPS);
  await $.command.run(run(""));
  const tasks = ["Fix the type errors in the printer module", "Map the router callers", "Review the ledger design"];
  for (const [index, description] of tasks.entries()) await $.agent.spawn(spawnOf(index + 1, "executor", description, "Go."));
  w.agents = running(3);
  const ui = await $.ui.mount(pane("terminal", INLINE_80));

  expect(body(await ui.drawn())[0]).toBe("◆ executor · Fix the type errors in the printer module                 0s");
  await ui.unmount();
});

test("every lane's head holds the ring's first stop: the first lane in view takes it, compact or relaxed", async ($, on) => {
  await threeAgents($, on);
  const stops = async (size: Size) => {
    const ui = await $.ui.mount(pane("terminal", size));
    const flags = await Promise.all(["a-1", "a-2", "a-3"].map(async (id) => (await ui.find({ key: `open-${id}` }))?.props["autoFocus"]));
    await ui.unmount();
    return flags;
  };

  expect(await stops(DOCK_120)).toEqual([true, undefined, undefined]);
  expect(await stops(DOCK_COMPACT)).toEqual([true, undefined, undefined]);
});

test("the empty state tells what a lane is and how to open it", async ($, on) => {
  world(on, {});
  engine(on, {});
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", DOCK_120));

  expect(body(await ui.drawn())).toEqual(["No subagent has run in this session yet.", "Each subagent gets a lane here. Enter or a click opens its page."]);
  await ui.unmount();
});
