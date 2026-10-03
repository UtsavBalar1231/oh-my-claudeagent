import type { RenderElement } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import type { MetricsRecord } from "../../src/core/metrics.ts";
import { usableColumns } from "../../src/core/ui-kit.ts";
import {
  bodyColumns,
  cellsAcross,
  childrenOf,
  isAscii,
  isNode,
  nodeByKey,
  pane,
  resettableState,
  ROOT,
  rows,
  run,
  type Size,
  SIZES,
  spreadRows,
  topRows,
  world,
  write,
} from "./world.ts";

const METRICS = `${ROOT}/.omca/metrics`;
const DOCK_200: Size = { columns: 200, rows: 50, placement: "dock" };

const record = (sessionId: string, agentId: string, fields: Partial<MetricsRecord>): string =>
  JSON.stringify({
    session_id: sessionId,
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
  } satisfies MetricsRecord);

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const EXPLORE = { agent_type: "oh-my-claudeagent:explore", model: "claude-haiku-4-5", evidence_logged: false } as const;
const ORACLE = { agent_type: "oh-my-claudeagent:oracle", model: "gateway-reasoner", estimated_cost_usd: null } as const;

const FIXTURE = {
  [`${METRICS}/${S1}/a-e1.json`]: record(S1, "a-e1", { duration_ms: 60_000 }),
  [`${METRICS}/${S1}/a-e2.json`]: record(S1, "a-e2", { duration_ms: 240_000, input_tokens: 900_000, output_tokens: 90_000, estimated_cost_usd: 2.7 }),
  [`${METRICS}/${S1}/a-x1.json`]: record(S1, "a-x1", { ...EXPLORE, duration_ms: 20_000, input_tokens: 8_000, output_tokens: 1_000, estimated_cost_usd: 0.013 }),
  [`${METRICS}/${S1}/a-o1.json`]: record(S1, "a-o1", { ...ORACLE, duration_ms: 400_000, input_tokens: 120_000, output_tokens: 9_000 }),
  [`${METRICS}/${S1}/broken.json`]: '{"session_id": "',
  [`${METRICS}/${S2}/a-e3.json`]: record(S2, "a-e3", { outcome: "aborted", duration_ms: 90_000, input_tokens: 5_000, output_tokens: 500, estimated_cost_usd: 0.015, evidence_logged: false }),
  [`${METRICS}/${S2}/a-x2.json`]: record(S2, "a-x2", { ...EXPLORE, outcome: "empty", model: "gateway-small", duration_ms: 10_000, input_tokens: 3_000, output_tokens: 0, estimated_cost_usd: null }),
  [`${METRICS}/${S2}/a-x3.json`]: record(S2, "a-x3", { ...EXPLORE, outcome: "running", ended_at: null, duration_ms: null, input_tokens: 0, output_tokens: 0, estimated_cost_usd: null, evidence_logged: null }),
  [`${METRICS}/${S2}/notes.txt`]: "not a record",
};

const FILES = {
  [`${METRICS}/${S1}/a-1.json`]: record(S1, "a-1", { started_at: "2026-10-01T09:00:00.000Z" }),
  [`${METRICS}/${S1}/a-2.json`]: record(S1, "a-2", { started_at: "2026-10-01T09:10:00.000Z", input_tokens: 400_000, output_tokens: 20_000, estimated_cost_usd: 1.2 }),
  [`${METRICS}/${S1}/a-3.json`]: record(S1, "a-3", { ...EXPLORE, started_at: "2026-10-01T09:05:00.000Z", input_tokens: 9_000, output_tokens: 1_000, estimated_cost_usd: 0.014 }),
  [`${METRICS}/${S1}/a-4.json`]: record(S1, "a-4", { ...ORACLE, started_at: "2026-10-01T09:20:00.000Z", input_tokens: 200_000, output_tokens: 10_000, outcome: "aborted" }),
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

async function statsTab($: Engine, size: Size = DOCK_200): Promise<RenderElement> {
  await $.command.run(run("stats", size.columns));
  const ui = await $.ui.mount(pane("terminal", size));
  const tree = await ui.drawn();
  await ui.unmount();
  return tree;
}

test("the agents card draws each agent in its roster color with a bar of its runs, and evidence and outcomes with their glyphs in tone", async ($, on) => {
  world(on, FILES);
  const agents = nodeByKey(await statsTab($), "stats-agents");
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
      lit({ color: "success" }, "  ✓"),
      lit({}, " 100%"),
      gap,
      lit({ color: "success" }, "✓"),
      lit({}, "2  "),
      lit({ color: "inactive" }, "✗"),
      lit({ color: "inactive" }, "0  "),
      lit({ color: "inactive" }, "!"),
      lit({ color: "inactive" }, "0  "),
    ),
    row(
      "stats-oh-my-claudeagent:explore",
      lit({ color: BLUE }, "◆ "),
      lit({ color: BLUE }, "explore "),
      gap,
      lit({ color: BLUE }, "█████"),
      lit({ color: "subtle" }, "█████"),
      gap,
      lit({}, "   1"),
      gap,
      lit({}, " 2m00s"),
      gap,
      lit({}, " 10.0k"),
      gap,
      lit({}, "    $0.01"),
      gap,
      lit({ color: "error" }, "    ✗"),
      lit({}, " 0%"),
      gap,
      lit({ color: "success" }, "✓"),
      lit({}, "1  "),
      lit({ color: "inactive" }, "✗"),
      lit({ color: "inactive" }, "0  "),
      lit({ color: "inactive" }, "!"),
      lit({ color: "inactive" }, "0  "),
    ),
    row(
      "stats-oh-my-claudeagent:oracle",
      lit({ color: PURPLE }, "◆ "),
      lit({ color: PURPLE }, "oracle  "),
      gap,
      lit({ color: PURPLE }, "█████"),
      lit({ color: "subtle" }, "█████"),
      gap,
      lit({}, "   1"),
      gap,
      lit({}, " 2m00s"),
      gap,
      lit({}, "  210k"),
      gap,
      lit({ color: "inactive" }, "      n/a"),
      gap,
      lit({ color: "success" }, "  ✓"),
      lit({}, " 100%"),
      gap,
      lit({ color: "inactive" }, "✓"),
      lit({ color: "inactive" }, "0  "),
      lit({ color: "error" }, "✗"),
      lit({}, "1  "),
      lit({ color: "inactive" }, "!"),
      lit({ color: "inactive" }, "0  "),
    ),
  ]);
});

test("the tokens card draws one cell per finished turn, oldest first, in its agent's color, and the peak", async ($, on) => {
  world(on, { ...FILES, [`${METRICS}/${S1}/a-5.json`]: record(S1, "a-5", { outcome: "running", ended_at: null, duration_ms: null, estimated_cost_usd: null, evidence_logged: null }) });
  const tokens = nodeByKey(await statsTab($), "stats-tokens");

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
  const cost = nodeByKey(await statsTab($), "stats-cost");

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
  const cost = nodeByKey(await statsTab($), "stats-cost");

  expect(cost).toEqual(
    card("stats-cost", "warning", 85, "Estimated cost", text({ dimColor: true, wrap: "wrap" }, "No finished run has a listed price, so no cost is shown")),
  );
});

test("at the split tier the tokens and cost cards sit side by side at half the body each", async ($, on) => {
  world(on, FILES);
  const split: Size = { columns: 200, rows: 50, placement: "inline" };
  const lower = nodeByKey(await statsTab($, split), "stats-lower");
  const half = Math.floor((bodyColumns(split) - 3 - 1) / 2);

  expect(lower?.props).toEqual({ key: "stats-lower", flexDirection: "row", columnGap: 1, width: half * 2 + 1 });
  expect(childrenOf(lower ?? { type: "" }).map((child) => (isNode(child) ? [child.props?.["key"], child.props?.["width"]] : []))).toEqual([
    ["stats-tokens", half],
    ["stats-cost", half],
  ]);
});

test("a drawn table's only key is r, and after the stats atom resets the tab says it is reading, with no key", async ($, on) => {
  const atoms = resettableState(on);
  world(on, FILES);
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", DOCK_200));
  await ui.press({ key: "6" });
  await ui.redraw();
  const keys = async () => (await ui.findAll({ type: "Button" })).flatMap((found) => (/^\d$/.test(String(found.props["hotkey"])) ? [] : [found.props["hotkey"]]));
  expect(await keys()).toEqual(["r"]);

  atoms.reset("stats");
  await ui.redraw();
  expect(topRows(await ui.drawn()).slice(2)).toEqual([text({ color: "inactive", dimColor: true }, "Reading the delegation records…")]);
  expect(rows(await ui.drawn())).toHaveLength(3);
  expect(await keys()).toEqual([]);
  await ui.unmount();
});

test("a table taller than its window draws a more-below cue over the window's last row, until the engine's own height says the end shows", async ($, on) => {
  world(on, FILES);
  on("ui.scroll", () => ({}));
  await $.command.run(run("stats", 120));
  const SHORT: Size = { columns: 120, rows: 20, placement: "dock" };
  const mount = pane("terminal", SHORT);
  const ui = (offset: number) => $.ui.mount({ ...mount, props: { ...mount.props, scroll: { offset, bodyRows: 16 } } });
  const cueAt = async (offset: number) => {
    const drawn = await ui(offset);
    const cue = nodeByKey(await drawn.drawn(), "more-cue");
    await drawn.unmount();
    return cue;
  };

  const cue = await cueAt(0);
  expect(cue?.props).toEqual({ key: "more-cue", position: "absolute", top: 15, left: 0, width: bodyColumns(SHORT) - 3 });
  expect(childrenOf(cue ?? { type: "" })).toEqual([text({ dimColor: true }, "  ↓ more · ↑↓ scroll".padEnd(bodyColumns(SHORT) - 3))]);
  expect((await cueAt(4))?.props?.["top"]).toBe(19);
  expect(await cueAt(40)).toBeUndefined();

  const drawn = await ui(0);
  await $.ui.scroll({ component: "Pane", requestId: "omca", offset: 0, by: 1, bodyRows: 16, contentRows: 16, origin: { kind: "person" } });
  await drawn.redraw();
  expect(nodeByKey(await drawn.drawn(), "more-cue")).toBeUndefined();
  await drawn.unmount();
});

const SURFACES = ["terminal", "desktop"] as const;

test("the Stats tab aggregates two sessions by agent type with exact rows, on the terminal and the desktop", async ($, on) => {
  world(on, FIXTURE);
  expect(await $.command.run(run("stats", 200))).toEqual({});
  const summary = "7 delegations in 2 sessions · 1 running · 1 unreadable record skipped";

  const notes = "+ excludes 1 unpriced run · n/a: no listed price · 2026-10-02 list prices";

  for (const surface of SURFACES) {
    const wide = await $.ui.mount(pane(surface, { columns: 200, rows: 50, placement: "dock" }));
    expect(spreadRows(await wide.drawn()).slice(2)).toEqual([
      summary,
      "Agents · 3 types",
      "  agent                 runs  median  tokens  est. cost  evidence  outcomes    ",
      `◆ executor  ${"█".repeat(10)}     3   1m30s    1.0M      $2.86     ! 67%  ✓2  ✗1  !0  `,
      `◆ explore   ${"█".repeat(10)}     3     15s   12.0k     $0.01+      ✗ 0%  ✓1  ✗0  !1  `,
      `◆ oracle    ${"█".repeat(10)}     1   6m40s    129k        n/a    ✓ 100%  ✓1  ✗0  !0  `,
      "Tokens per turn · 6 turns",
      "▁█▁▂▁▁ peak 990k",
      "Estimated cost",
      `$2.87+ ${"█".repeat(74)}`,
      "◆ executor $2.86  ◆ explore $0.01",
      notes,
      "r: Reload",
    ]);
    await wide.unmount();

    const narrow = await $.ui.mount(pane(surface, { columns: 120, rows: 40, placement: "dock" }));
    expect(spreadRows(await narrow.drawn()).slice(3)).toEqual([
      "7 delegations in 2 sessions · 1 running · 1 skipped",
      "Agents · 3 types",
      "  agent     runs  est. cost  evidence",
      "◆ executor     3      $2.86     ! 67%",
      "◆ explore      3     $0.01+      ✗ 0%",
      "◆ oracle       1        n/a    ✓ 100%",
      "Tokens per turn · 6 turns",
      "▁█▁▂▁▁ peak 990k",
      "Estimated cost",
      `$2.87+ ${"█".repeat(40)}`,
      "◆ executor $2.86  ◆ explore $0.01",
      notes,
      "r: Reload",
    ]);
    await narrow.unmount();
  }
});

test("Stats rows stay inside the body less the gutter at every size, docked and inline, on both surfaces", async ($, on) => {
  world(on, { ...FIXTURE, [`${METRICS}/${S2}/a-m1.json`]: record(S2, "a-m1", { agent_type: "oh-my-claudeagent:multimodal-looker" }) });
  await $.command.run(run("stats"));

  for (const size of SIZES) {
    for (const surface of SURFACES) {
      const room = usableColumns(bodyColumns(size));
      const ui = await $.ui.mount(pane(surface, size));
      for (const child of topRows(await ui.drawn())) {
        expect(cellsAcross(child), `${size.columns} ${size.placement} ${surface}`).toBeLessThanOrEqual(room);
      }
      await ui.unmount();
    }
  }
});

test("digit 6 reads the records afresh each time, r reloads a drawn table, and a failed read shows its reason", async ($, on) => {
  const w = world(on);
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  const body = async () => rows(await ui.drawn()).slice(3);

  await ui.press({ key: "6" });
  expect(await body()).toEqual(["No delegation statistics have been collected yet.", "r: Reload"]);

  write(w, `${METRICS}/${S1}/broken.json`, "{");
  await ui.press({ key: "1" });
  await ui.press({ key: "6" });
  expect(await body()).toEqual(["No delegation statistics have been collected yet.", "1 unreadable record skipped", "r: Reload"]);

  write(w, `${METRICS}/${S1}/a-e1.json`, record(S1, "a-e1", {}));
  await ui.press({ key: "1" });
  await ui.press({ key: "6" });
  expect((await body())[0]).toBe("1 delegation in 1 session · 1 skipped");

  w.files.clear();
  write(w, METRICS, "a file where the directory belongs");
  await ui.press({ key: "r" });
  expect(await body()).toEqual(["✗ Could not read .omca/metrics: ENOENT: no such di…", "r: Reload"]);
  await ui.unmount();
});

test("OMCA_ASCII draws the Stats tab from the ASCII set", async ($, on) => {
  world(on, FIXTURE, {}, { OMCA_ASCII: "1" });
  await $.command.run(run("stats", 80));
  const ui = await $.ui.mount(pane("terminal", { columns: 80, rows: 40, placement: "inline" }));
  const drawn = spreadRows(await ui.drawn());
  expect(drawn.slice(1, 13)).toEqual([
    "7 delegations in 2 sessions - 1 running - 1 unreadable record skipped",
    "Agents - 3 types",
    "  agent                 runs  median  tokens  est. cost  evidence",
    "@ executor  [########]     3   1m30s    1.0M      $2.86     ! 67%",
    "@ explore   [########]     3     15s   12.0k     $0.01+      x 0%",
    "@ oracle    [###.....]     1   6m40s    129k        n/a    + 100%",
    "Tokens per turn - 6 turns",
    ".@.:.. peak 990k",
    "Estimated cost",
    `$2.87+ [${"#".repeat(59)}=]`,
    "# executor $2.86  = explore $0.01",
    "+ excludes 1 unpriced run - n/a: no listed price - 2026-10-02 list prices",
  ]);
  expect(drawn.filter((row) => !isAscii(row))).toEqual([]);
  await ui.unmount();
});
