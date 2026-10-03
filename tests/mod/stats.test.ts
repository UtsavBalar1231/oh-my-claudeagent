import type { RenderElement } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import type { LedgerRecord } from "../../src/core/ledger.ts";
import { bodyColumns, pane, resettableState, ROOT, rows, run, type Size, topRows, world } from "./world.ts";

const METRICS = `${ROOT}/.omca/metrics`;
const S1 = "11111111-1111-4111-8111-111111111111";
const DOCK_200: Size = { columns: 200, rows: 50, placement: "dock" };

const record = (agentId: string, fields: Partial<LedgerRecord>): string =>
  JSON.stringify({
    session_id: S1,
    agent_id: agentId,
    agent_type: "oh-my-claudeagent:executor",
    model: "claude-sonnet-5-5",
    effort: "high",
    started_at: "2026-10-01T09:00:00.000Z",
    ended_at: "2026-10-01T09:02:00.000Z",
    duration_ms: 120_000,
    input_tokens: 40_000,
    output_tokens: 6_000,
    estimated_cost_usd: 0.14,
    outcome: "completed",
    evidence_logged: true,
    ...fields,
  } satisfies LedgerRecord);

const ORACLE = { agent_type: "oh-my-claudeagent:oracle", model: "gateway-reasoner", estimated_cost_usd: null } as const;
const EXPLORE = { agent_type: "oh-my-claudeagent:explore", model: "claude-haiku-4-5", evidence_logged: false } as const;

const FILES = {
  [`${METRICS}/${S1}/a-1.json`]: record("a-1", { started_at: "2026-10-01T09:00:00.000Z" }),
  [`${METRICS}/${S1}/a-2.json`]: record("a-2", { started_at: "2026-10-01T09:10:00.000Z", input_tokens: 400_000, output_tokens: 20_000, estimated_cost_usd: 1.2 }),
  [`${METRICS}/${S1}/a-3.json`]: record("a-3", { ...EXPLORE, started_at: "2026-10-01T09:05:00.000Z", input_tokens: 9_000, output_tokens: 1_000, estimated_cost_usd: 0.014 }),
  [`${METRICS}/${S1}/a-4.json`]: record("a-4", { ...ORACLE, started_at: "2026-10-01T09:20:00.000Z", input_tokens: 200_000, output_tokens: 10_000, outcome: "aborted" }),
};

const GREEN = "green_FOR_SUBAGENTS_ONLY";
const BLUE = "blue_FOR_SUBAGENTS_ONLY";
const PURPLE = "purple_FOR_SUBAGENTS_ONLY";

const text = (props: Record<string, unknown>, run: string) => ({ type: "Text", ...(Object.keys(props).length === 0 ? {} : { props }), children: [run] });
const lit = (props: Record<string, unknown>, run: string) => ({ ...text(props, run), hover: { color: "text" } });
const line = (...pieces: unknown[]) => ({ type: "Text", props: { wrap: "truncate-end" }, children: pieces });
const row = (key: string, ...pieces: unknown[]) => ({
  type: "Box",
  props: { key, flexDirection: "row" },
  hover: { backgroundColor: "selectionBg" },
  children: [line(...pieces)],
});
const card = (key: string, border: string, width: number, title: string, ...children: unknown[]) => ({
  type: "Box",
  props: { key, flexDirection: "column", borderStyle: "round", borderColor: border, paddingX: 1, width },
  children: [text({ bold: true, color: "text", wrap: "truncate-end" }, title), ...children],
});

type Node = { type: string; props?: Record<string, unknown>; children?: unknown };
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && "type" in value;
const childrenOf = (node: Node): unknown[] => (Array.isArray(node.children) ? node.children : node.children === undefined ? [] : [node.children]);

function node(element: unknown, key: string): Node | undefined {
  if (!isNode(element)) return undefined;
  if (element.props?.["key"] === key) return element;
  return childrenOf(element).reduce<Node | undefined>((found, child) => found ?? node(child, key), undefined);
}

async function statsTab($: Engine, size: Size = DOCK_200): Promise<RenderElement> {
  await $.command.run(run("stats", size.columns));
  const ui = await $.ui.mount(pane("terminal", size));
  const tree = await ui.drawn();
  await ui.unmount();
  return tree;
}

test("the agents card draws each agent in its roster color with a bar of its runs, evidence in its tone and outcomes by glyph", async ($, on) => {
  world(on, FILES);
  const agents = node(await statsTab($), "stats-agents");
  const gap = lit({}, "  ");

  expect(childrenOf(agents ?? { type: "" })).toEqual([
    text({ bold: true, color: "text", wrap: "truncate-end" }, "Agents · 3 types"),
    text({ dimColor: true }, "  agent                 runs  median  tokens  est. cost  evidence  outcomes    "),
    row(
      "stats-oh-my-claudeagent:executor",
      lit({ color: GREEN }, "◆ "),
      lit({ color: GREEN }, "executor"),
      gap,
      lit({ color: GREEN }, "██████████"),
      gap,
      lit({}, "   2"),
      gap,
      lit({}, " 2m00s"),
      gap,
      lit({}, "  466k"),
      gap,
      lit({}, "    $1.34"),
      gap,
      lit({ color: "success" }, "    100%"),
      gap,
      lit({ color: "success" }, "✓2  "),
      lit({ color: "inactive" }, "✗0  "),
      lit({ color: "inactive" }, "!0  "),
    ),
    row(
      "stats-oh-my-claudeagent:explore",
      lit({ color: BLUE }, "◆ "),
      lit({ color: BLUE }, "explore "),
      gap,
      lit({ color: BLUE }, "█████"),
      lit({ color: "rate_limit_empty" }, "█████"),
      gap,
      lit({}, "   1"),
      gap,
      lit({}, " 2m00s"),
      gap,
      lit({}, " 10.0k"),
      gap,
      lit({}, "    $0.01"),
      gap,
      lit({ color: "error" }, "      0%"),
      gap,
      lit({ color: "success" }, "✓1  "),
      lit({ color: "inactive" }, "✗0  "),
      lit({ color: "inactive" }, "!0  "),
    ),
    row(
      "stats-oh-my-claudeagent:oracle",
      lit({ color: PURPLE }, "◆ "),
      lit({ color: PURPLE }, "oracle  "),
      gap,
      lit({ color: PURPLE }, "█████"),
      lit({ color: "rate_limit_empty" }, "█████"),
      gap,
      lit({}, "   1"),
      gap,
      lit({}, " 2m00s"),
      gap,
      lit({}, "  210k"),
      gap,
      lit({ color: "inactive" }, "      n/a"),
      gap,
      lit({ color: "success" }, "    100%"),
      gap,
      lit({ color: "inactive" }, "✓0  "),
      lit({ color: "error" }, "✗1  "),
      lit({ color: "inactive" }, "!0  "),
    ),
  ]);
});

test("the tokens card draws one cell per finished turn, oldest first, in its agent's color, and the peak", async ($, on) => {
  world(on, { ...FILES, [`${METRICS}/${S1}/a-5.json`]: record("a-5", { outcome: "running", ended_at: null, duration_ms: null, estimated_cost_usd: null, evidence_logged: null }) });
  const tokens = node(await statsTab($), "stats-tokens");

  expect(tokens).toEqual(
    card(
      "stats-tokens",
      "permission",
      85,
      "Tokens per turn · 4 turns",
      line(
        text({ color: GREEN }, "▂"),
        text({ color: BLUE }, "▁"),
        text({ color: GREEN }, "█"),
        text({ color: PURPLE }, "▅"),
        text({ color: "inactive" }, " peak 420k"),
      ),
    ),
  );
});

test("the cost card totals the priced runs, splits its meter by agent with the costliest first, and names what it leaves out", async ($, on) => {
  world(on, FILES);
  const cost = node(await statsTab($), "stats-cost");

  expect(cost).toEqual(
    card(
      "stats-cost",
      "success",
      85,
      "Estimated cost",
      line(text({ bold: true }, "$1.35+"), text({}, " "), text({ color: GREEN }, "█".repeat(73)), text({ color: BLUE }, "█")),
      line(text({ color: GREEN }, "◆ "), text({}, "executor $1.34"), text({}, "  "), text({ color: BLUE }, "◆ "), text({}, "explore $0.01")),
      text({ dimColor: true, wrap: "wrap" }, "n/a: no listed price · 2026-10-02 list prices"),
    ),
  );
});

test("with no priced run the cost card says so in the warn tone and shows no figure", async ($, on) => {
  world(on, { [`${METRICS}/${S1}/a-4.json`]: FILES[`${METRICS}/${S1}/a-4.json`] ?? "" });
  const cost = node(await statsTab($), "stats-cost");

  expect(cost).toEqual(
    card("stats-cost", "warning", 85, "Estimated cost", text({ dimColor: true, wrap: "wrap" }, "No finished run has a listed price, so no cost is shown")),
  );
});

test("at the split tier the tokens and cost cards sit side by side at half the body each", async ($, on) => {
  world(on, FILES);
  const split: Size = { columns: 200, rows: 50, placement: "inline" };
  const lower = node(await statsTab($, split), "stats-lower");
  const half = Math.floor((bodyColumns(split) - 3 - 1) / 2);

  expect(lower?.props).toEqual({ key: "stats-lower", flexDirection: "row", columnGap: 1, width: half * 2 + 1 });
  expect(childrenOf(lower ?? { type: "" }).map((child) => (isNode(child) ? [child.props?.["key"], child.props?.["width"]] : []))).toEqual([
    ["stats-tokens", half],
    ["stats-cost", half],
  ]);
});

test("after the stats atom resets the tab says it is reading, and r is its only key", async ($, on) => {
  const atoms = resettableState(on);
  world(on, FILES);
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", DOCK_200));
  await ui.press({ key: "6" });
  await ui.redraw();
  const keys = (await ui.findAll({ type: "Button" })).flatMap((found) => (/^\d$/.test(String(found.props["hotkey"])) ? [] : [found.props["hotkey"]]));
  expect(keys).toEqual(["r"]);

  atoms.reset("stats");
  await ui.redraw();
  expect(topRows(await ui.drawn()).slice(2)).toEqual([text({ color: "inactive", dimColor: true }, "Reading the delegation records…")]);
  expect(rows(await ui.drawn())).toHaveLength(3);
  await ui.unmount();
});
