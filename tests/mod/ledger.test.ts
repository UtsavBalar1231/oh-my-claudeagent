import type { Args, On, TurnUsage } from "claude-code";
import { type Engine, expect, type Mounted as MountedPane, test } from "claude-code/testing";
import { sha256Hex } from "../../src/core/evidence.ts";
import type { LedgerRecord } from "../../src/core/ledger.ts";
import { displayWidth, padEnd, usableColumns } from "../../src/core/ui-kit.ts";
import {
  BOULDER,
  bodyColumns,
  cellsAcross,
  LEDGER,
  pane,
  resettableState,
  ROOT,
  rows,
  run,
  SESSION,
  SIZES,
  type Size,
  topRows,
  type World,
  world,
  write,
} from "./world.ts";

const METRICS = `${ROOT}/.omca/metrics`;
const SURFACES = ["terminal", "desktop"] as const;

const usage = (model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): TurnUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  model,
});

const spawn = (subagentType: string, description: string): Args<"agent.spawn"> => ({
  tool_use_id: `toolu-${description}`,
  prompt: description,
  description,
  subagentType,
  provider: { plugin: "oh-my-claudeagent", tier: "user" },
  parentModel: "claude-opus-5-5",
  background: true,
  fork: false,
});

const complete = (agentId: string, fields: Partial<Args<"turn.complete">>): Args<"turn.complete"> =>
  ({ answer: "", durationMs: 0, isAborted: false, turnId: `t-${agentId}`, reason: "answer", agentId, ...fields }) as Args<"turn.complete">;

function engine(on: On, files: Readonly<Record<string, string>> = {}): { w: World; writes: [string, unknown][] } {
  const w = world(on, files);
  const writes: [string, unknown][] = [];
  on("fs.write", (_$, e) => {
    writes.push([w.spelled(e.path), JSON.parse(e.text)]);
    write(w, e.path, e.text);
    return { value: undefined };
  });
  const models: Record<string, readonly [string, string]> = {
    "oh-my-claudeagent:executor": ["claude-sonnet-5-5", "a-1"],
    "oh-my-claudeagent:explore": ["claude-haiku-4-5", "a-2"],
    "oh-my-claudeagent:oracle": ["claude-fable-5-1", "../escape"],
  };
  on("agent.spawn", (_$, e) => {
    const [model, agentId] = models[e.subagentType] ?? ["claude-opus-5-5", "a-9"];
    return { model, agentId };
  });
  on("turn.step", async function* (_$, e) {
    const counted = e.agentId === "a-1" ? usage("claude-sonnet-5-5", 2000, 500, 10_000, 1000) : null;
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: counted };
  });
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  return { w, writes };
}

async function step(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
  for (let next = await stream.next(); next.done !== true; next = await stream.next());
}

const evidenceAt = (...timestamps: string[]) =>
  JSON.stringify({ entries: timestamps.map((timestamp) => ({ type: "test", command: "just test", exit_code: 0, output_snippet: "ok", timestamp })) });

test("each delegation is written running at spawn and overwritten once when its turn completes or aborts", async ($, on) => {
  const { w, writes } = engine(on, { [LEDGER]: evidenceAt("2026-10-02T12:00:15Z") });

  await $.agent.spawn(spawn("oh-my-claudeagent:executor", "Fix the parser"));
  await w.clock.advance(30_000);
  await $.agent.spawn(spawn("oh-my-claudeagent:explore", "Find the callers"));
  const running1: LedgerRecord = {
    session_id: "s1",
    agent_id: "a-1",
    agent_type: "oh-my-claudeagent:executor",
    model: "claude-sonnet-5-5",
    effort: null,
    started_at: "2026-10-02T12:00:00.000Z",
    ended_at: null,
    duration_ms: null,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
    outcome: "running",
    evidence_logged: null,
  };
  const running2: LedgerRecord = {
    ...running1,
    agent_id: "a-2",
    agent_type: "oh-my-claudeagent:explore",
    model: "claude-haiku-4-5",
    started_at: "2026-10-02T12:00:30.000Z",
  };
  expect(writes).toEqual([
    [`${METRICS}/s1/a-1.json`, running1],
    [`${METRICS}/s1/a-2.json`, running2],
  ]);

  await step($.turn.step({ turnId: "t-a-1", index: 0, model: "claude-sonnet-5-5", effort: "high", messageCount: 1, agentId: "a-1" }));
  await step($.turn.step({ turnId: "t-a-2", index: 0, model: "claude-haiku-4-5", messageCount: 1, agentId: "a-2" }));
  await w.clock.advance(60_000);
  await $.turn.complete(complete("a-1", { answer: "Fixed the parser.", durationMs: 90_000, usage: usage("claude-sonnet-5-5", 2000, 500, 10_000, 1000) }));
  await w.clock.advance(15_000);
  await $.turn.complete(complete("a-2", { reason: "aborted", isAborted: true, durationMs: 75_000 }));

  expect(writes.slice(2)).toEqual([
    [
      `${METRICS}/s1/a-1.json`,
      {
        ...running1,
        effort: "high",
        ended_at: "2026-10-02T12:01:30.000Z",
        duration_ms: 90_000,
        input_tokens: 13_000,
        output_tokens: 500,
        estimated_cost_usd: 0.0135,
        outcome: "completed",
        evidence_logged: true,
      },
    ],
    [
      `${METRICS}/s1/a-2.json`,
      {
        ...running2,
        ended_at: "2026-10-02T12:01:45.000Z",
        duration_ms: 75_000,
        estimated_cost_usd: 0,
        outcome: "aborted",
        evidence_logged: false,
      },
    ],
  ]);

  await w.clock.advance(5_000);
  await $.turn.complete(complete("a-1", { answer: "A later run of the same agent." }));
  await $.turn.complete(complete("a-7", { answer: "Never spawned here." }));
  await $.turn.complete({ answer: "The main loop.", durationMs: 1_000, isAborted: false, turnId: "t-main", reason: "answer" });
  expect(writes).toHaveLength(4);

  expect(await $.command.run(run("stats"))).toEqual({});
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface, { columns: 120, rows: 40, placement: "dock" }));
    expect(rows(await ui.drawn()).slice(3)).toEqual([
      "2 delegations in 1 session",
      "agent     runs  median  tokens  est. cost  evidence",
      "executor     1   1m30s   13.5k      $0.01      100%",
      "explore      1   1m15s       0      $0.00        0%",
      "r: Reload  estimated at 2026-10-02 list prices",
    ]);
    await ui.unmount();
  }
});

test("a turn that reports no usage after its steps counted tokens leaves the cost unpriced, not zero", async ($, on) => {
  const { w, writes } = engine(on);
  await $.agent.spawn(spawn("oh-my-claudeagent:executor", "Fix the parser"));
  await step($.turn.step({ turnId: "t-a-1", index: 0, model: "claude-sonnet-5-5", messageCount: 1, agentId: "a-1" }));
  await w.clock.advance(1_000);
  await $.turn.complete(complete("a-1", { reason: "error", answer: "" }));

  expect(writes.at(-1)?.[1]).toMatchObject({
    input_tokens: 13_000,
    output_tokens: 500,
    estimated_cost_usd: null,
    outcome: "empty",
    evidence_logged: false,
  });
});

test("an unsafe agent id names no file and writes nothing", async ($, on) => {
  const { w, writes } = engine(on);
  await $.agent.spawn(spawn("oh-my-claudeagent:oracle", "Review"));
  expect(writes).toEqual([]);
  expect(w.logs).toContain('ledger: no record for session "s1" agent "../escape"');
});

const record = (sessionId: string, agentId: string, fields: Partial<LedgerRecord>): string =>
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
  } satisfies LedgerRecord);

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

test("the Stats tab aggregates two sessions by agent type with exact rows, on the terminal and the desktop", async ($, on) => {
  engine(on, FIXTURE);
  expect(await $.command.run(run("stats", 200))).toEqual({});
  const summary = "7 delegations in 2 sessions · 1 running · 1 unreadable record skipped";

  for (const surface of SURFACES) {
    const wide = await $.ui.mount(pane(surface, { columns: 200, rows: 50, placement: "inline" }));
    expect(rows(await wide.drawn()).slice(1)).toEqual([
      summary,
      "agent     runs  median  tokens  est. cost  evidence  done  abort  empty",
      "executor     3   1m30s    1.0M      $2.86       67%     2      1      0",
      "explore      3     15s   12.0k     $0.01+        0%     1      0      1",
      "oracle       1   6m40s    129k        n/a      100%     1      0      0",
      "+ excludes 1 unpriced run · n/a: no listed price",
      "r: Reload  estimated at 2026-10-02 list prices",
    ]);
    await wide.unmount();

    const narrow = await $.ui.mount(pane(surface, { columns: 120, rows: 40, placement: "dock" }));
    expect(rows(await narrow.drawn()).slice(3)).toEqual([
      "7 delegations in 2 sessions · 1 running · 1 skipped",
      "agent     runs  median  tokens  est. cost  evidence",
      "executor     3   1m30s    1.0M      $2.86       67%",
      "explore      3     15s   12.0k     $0.01+        0%",
      "oracle       1   6m40s    129k        n/a      100%",
      "+ excludes 1 unpriced run · n/a: no listed price",
      "r: Reload  estimated at 2026-10-02 list prices",
    ]);
    await narrow.unmount();
  }
});

test("Stats rows stay inside the body less the gutter at every size, docked and inline, on both surfaces", async ($, on) => {
  engine(on, { ...FIXTURE, [`${METRICS}/${S2}/a-m1.json`]: record(S2, "a-m1", { agent_type: "oh-my-claudeagent:multimodal-looker" }) });
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
  const { w } = engine(on);
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  const body = async () => rows(await ui.drawn()).slice(3);

  await ui.press({ key: "6" });
  expect(await body()).toEqual(["No delegation statistics have been collected yet."]);

  write(w, `${METRICS}/${S1}/broken.json`, "{");
  await ui.press({ key: "1" });
  await ui.press({ key: "6" });
  expect(await body()).toEqual(["No delegation statistics have been collected yet.", "1 unreadable record skipped"]);

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
  const drawn = rows(await ui.drawn());
  expect(drawn.slice(1, 3)).toEqual([
    "7 delegations in 2 sessions - 1 running - 1 unreadable record skipped",
    "agent     runs  median  tokens  est. cost  evidence  done  abort  empty",
  ]);
  const isAscii = (row: string) => [...row].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) < 127);
  expect(drawn.filter((row) => !isAscii(row))).toEqual([]);
  await ui.unmount();
});

// The Evidence tab: the proof ledger.

const PLAN_PATH = `${ROOT}/plans/sample.md`;
const PLAN_TEXT = "# Sample plan\n\n## TODOs\n\n- [x] 1. Wire the ledger\n";
const BOUND = JSON.stringify({
  plans: { sample: { active_plan: PLAN_PATH, started_at: "2026-10-01T08:00:00Z" } },
  bindings: { [SESSION]: { plan_name: "sample" } },
});
const TOKEN = `ghp_${"a1B2c3D4".repeat(5)}`;
const BEARER = `Bearer ${"x9".repeat(10)}`;
const FAILING_OUTPUT = ["(fail) the ledger draws", "  expected 3", "  received 4", "at ledger.test.ts:40", "1 fail", "41 pass", "Ran 42 tests", "exit 1", "done", "end"].join("\n");

const local = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute, 0).toISOString();

const evidence = (type: string, command: string, exit: number, timestamp: string, by: string, snippet: string, planSha?: string) => ({
  type,
  command,
  exit_code: exit,
  output_snippet: snippet,
  timestamp,
  verified_by: by,
  ...(planSha === undefined ? {} : { plan_sha256: planSha }),
});

const runs = (planSha: string) => [
  evidence("build", "bun run build", 0, local(1, 9, 0), "oh-my-claudeagent:executor", "built in 1.2 s"),
  evidence("lint", "just lint", 1, local(1, 9, 30), "oh-my-claudeagent:explore", "src/core/evidence.ts:12 unused import"),
  evidence("test", "just test-mod", 1, local(2, 10, 0), "oh-my-claudeagent:executor", FAILING_OUTPUT),
  evidence("test", `curl -H 'Authorization: ${BEARER}' https://ci.example/run && just test`, 0, local(2, 10, 20), "oh-my-claudeagent:executor", `pushed with token=${TOKEN}\n42 pass`),
  evidence("manual", "bun scripts/qa/visual.ts evidence", 0, local(2, 11, 0), "sisyphus", ""),
  evidence("final_verification", "just ci", 0, local(2, 11, 45), "sisyphus", "COMPLETE", planSha),
];

async function proofFiles(planSha?: string): Promise<Record<string, string>> {
  const sha = planSha ?? (await sha256Hex(PLAN_TEXT));
  return { [PLAN_PATH]: PLAN_TEXT, [BOULDER]: BOUND, [LEDGER]: JSON.stringify({ entries: runs(sha) }) };
}

type Node = { type: string; props?: Record<string, unknown>; children?: unknown };
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && "type" in value;
const kids = (node: Node): unknown[] => (Array.isArray(node.children) ? node.children : node.children === undefined ? [] : [node.children]);

// The drawing as text, one entry per terminal row: a bordered Box is framed, a Code block's
// lines are marked `│`, an Input is bracketed, and a row Box lays its children side by side.
function lines(element: unknown): string[] {
  if (typeof element === "string") return [element];
  if (!isNode(element)) return [];
  const props = element.props ?? {};
  switch (element.type) {
    case "Text":
      return [kids(element).map((child) => lines(child).join("")).join("")];
    case "Button":
      return [`${String(props["hotkey"])}: ${String(props["label"])}`];
    case "Code":
      return String(props["source"]).split("\n").map((line) => `│${line}`);
    case "Input":
      return [`[${String(props["label"])}${String(props["value"]) || String(props["placeholder"])}]`];
    case "Box": {
      const children = kids(element);
      if (props["flexDirection"] === "row") {
        const columns = children.map(lines);
        const widths = children.map((child, index) => {
          const fixed = isNode(child) ? child.props?.["width"] : undefined;
          return typeof fixed === "number" ? fixed : Math.max(0, ...(columns[index] ?? []).map(displayWidth));
        });
        const gap = " ".repeat(typeof props["columnGap"] === "number" ? props["columnGap"] : 0);
        const height = Math.max(1, ...columns.map((column) => column.length));
        return Array.from({ length: height }, (_, row) =>
          columns.map((column, index) => padEnd(column[row] ?? "", widths[index] ?? 0)).join(gap).trimEnd(),
        );
      }
      const pad = " ".repeat(typeof props["paddingLeft"] === "number" ? props["paddingLeft"] : 0);
      const inner = children.flatMap(lines).map((line) => `${pad}${line}`);
      return props["borderStyle"] === undefined ? inner : ["╭", ...inner.map((line) => `│ ${line}`), "╰"];
    }
    default:
      return [];
  }
}

function nodeByKey(element: unknown, key: string): Node | undefined {
  if (!isNode(element)) return undefined;
  if (element.props?.["key"] === key) return element;
  for (const child of kids(element)) {
    const found = nodeByKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// A row's runs as drawn: each piece's text and the colors it carries.
function runsOf(row: Node | undefined): { text: string; color?: unknown; backgroundColor?: unknown; bold?: unknown }[] {
  const line = row === undefined ? undefined : kids(row)[0];
  return (isNode(line) ? kids(line) : []).flatMap((piece) => {
    if (!isNode(piece)) return [];
    const { color, backgroundColor, bold } = piece.props ?? {};
    return [{ text: kids(piece).join(""), ...(color === undefined ? {} : { color }), ...(backgroundColor === undefined ? {} : { backgroundColor }), ...(bold === undefined ? {} : { bold }) }];
  });
}

type Mounted = MountedPane<"terminal", "Pane">;

async function openEvidence($: Engine, size: Size): Promise<Mounted> {
  await $.command.run(run("", size.columns));
  const ui = await $.ui.mount(pane("terminal", size));
  await ui.press({ key: "3" });
  await ui.redraw();
  return ui;
}

const DOCK_120: Size = { columns: 120, rows: 40, placement: "dock" };
const INLINE_80: Size = { columns: 80, rows: 40, placement: "inline" };
const DOCK_210: Size = { columns: 210, rows: 50, placement: "dock" };
const DOCK_200: Size = { columns: 200, rows: 50, placement: "dock" };
// Tab rows and, docked, the rule under them.
const CHROME = { [DOCK_120.columns]: 3, [INLINE_80.columns]: 1, [DOCK_210.columns]: 2 } as const;
const body = async (ui: Mounted, size: Size) => lines(await ui.drawn()).slice(CHROME[size.columns] ?? 0);
const blanks = (count: number) => Array.from({ length: count }, () => " ");
const SCROLL = { component: "Pane", requestId: "omca", offset: 0, origin: { kind: "person" } } as const;

test("narrow: the verdict card, the day-grouped timeline and the focused entry opened under its row", async ($, on) => {
  world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_120);
  expect(await body(ui, DOCK_120)).toEqual([
    "╭",
    "│ FINAL VERIFICATION · sample",
    "│  COMPLETE  matches the plan as it is now",
    "│ 10-02 11:45 · ◆ sisyphus",
    "│ ●✗✗●●● last 6  build 1  test 2 ✗1  lint 1 ✗1",
    "│ manual 1  final 1",
    "╰",
    "── Fri 2026-10-02 ── ████████ 3/4 ─────────────────",
    "❯ 11:45  FINAL    ✓ 0  just ci                    ◆",
    "    │just ci",
    "    │COMPLETE",
    "    2026-10-02 11:45:00 · ◆ sisyphus",
    "  11:00  MANUAL   ✓ 0  bun scripts/q….ts evidence ◆",
    "  10:20  TEST     ✓ 0  curl -H 'Auth…&& just test ◆",
    "  10:00  TEST     ✗ 1  just test-mod              ◆",
    "── Thu 2026-10-01 ── ████████ 1/2 ─────────────────",
    "  09:30  LINT     ✗ 1  just lint                  ◆",
    "  09:00  BUILD    ✓ 0  bun run build              ◆",
    ...blanks(13),
    "b: Build  e: Test  l: Lint  m: Manual  v: Final",
    "x: Fails  c: Copy  r: Rerun  f: Find  1/6 · ↑↓ move",
    " ",
  ]);
  expect(nodeByKey(await ui.drawn(), "verdict")?.props).toMatchObject({ borderStyle: "round", borderColor: "success" });
  await ui.unmount();
});

test("standard: a one-line verdict above the timeline, agents named, the command shown again only when its row cut it", async ($, on) => {
  world(on, await proofFiles());
  const ui = await openEvidence($, INLINE_80);
  expect(await body(ui, INLINE_80)).toEqual([
    " COMPLETE  sample  ●✗✗●●● last 6  10-02 11:45  ◆ sisyphus  build 1 …",
    "── Fri 2026-10-02 ── ████████ 3/4 ───────────────────────────────────────",
    "❯ 11:45  FINAL    ✓ 0  just ci                                 ◆ sisyphus",
    "    │COMPLETE",
    "    2026-10-02 11:45:00 · ◆ sisyphus",
    "  11:00  MANUAL   ✓ 0  bun scripts/qa/visual.ts evidence       ◆ sisyphus",
    "  10:20  TEST     ✓ 0  curl -H 'Authorizat…le/run && just test ◆ executor",
    "  10:00  TEST     ✗ 1  just test-mod                           ◆ executor",
    "b: Build  e: Test  l: Lint  m: Manual  v: Final  x: Fails  c: Copy",
    "r: Rerun  f: Find  1/6 · ↑↓ move",
    " ",
  ]);

  await $.ui.scroll({ ...SCROLL, by: 2, bodyRows: 10, contentRows: 11 });
  expect((await body(ui, INLINE_80)).slice(1, 9)).toEqual([
    "── Fri 2026-10-02 ── ████████ 3/4 ───────────────────────────────────────",
    "  11:00  MANUAL   ✓ 0  bun scripts/qa/visual.ts evidence       ◆ sisyphus",
    "❯ 10:20  TEST     ✓ 0  curl -H 'Authorizat…le/run && just test ◆ executor",
    "    │curl -H 'Authorization: Bearer ‹masked›' https://ci.example/run && j…",
    "    │pushed with token=‹masked›",
    "    │42 pass",
    "    2026-10-02 10:20:00 · ◆ executor · ‹masked› 2 masked",
    "b: Build  e: Test  l: Lint  m: Manual  v: Final  x: Fails  c: Copy",
  ]);
  await ui.unmount();
});

test("wide: the list beside a card of the focused entry, which follows the focus", async ($, on) => {
  world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_210);
  const shown = await body(ui, DOCK_210);
  expect(shown.slice(0, 13)).toEqual([
    "╭",
    "│ FINAL VERIFICATION · sample",
    "│  COMPLETE  matches the plan as it is now · 10-02 11:45 · ◆ sisyphus",
    "│ ●✗✗●●● last 6  build 1  test 2 ✗1  lint 1 ✗1  manual 1  final 1",
    "╰",
    "── Fri 2026-10-02 ── ████████ 3/4 ─────────────  ╭",
    "❯ 11:45  FINAL    ✓ 0  just ci                ◆  │ FINAL · exit 0",
    "  11:00  MANUAL   ✓ 0  bun scripts…s evidence ◆  │ │just ci",
    "  10:20  TEST     ✓ 0  curl -H 'Au… just test ◆  │ │COMPLETE",
    "  10:00  TEST     ✗ 1  just test-mod          ◆  │ 2026-10-02 11:45:00 · ◆ sisyphus",
    "── Thu 2026-10-01 ── ████████ 1/2 ─────────────  ╰",
    "  09:30  LINT     ✗ 1  just lint              ◆",
    "  09:00  BUILD    ✓ 0  bun run build          ◆",
  ]);
  expect(shown.slice(-3)).toEqual(["b: Build  e: Test  l: Lint  m: Manual  v: Final  x: Fails  c: Copy  r: Rerun  f: Find", "1/6 · ↑↓ move", " "]);

  await $.ui.scroll({ ...SCROLL, by: 3, bodyRows: 46, contentRows: 47 });
  expect((await body(ui, DOCK_210)).slice(5, 20)).toEqual([
    "── Fri 2026-10-02 ── ████████ 3/4 ─────────────  ╭",
    "  11:45  FINAL    ✓ 0  just ci                ◆  │ TEST · exit 1",
    "  11:00  MANUAL   ✓ 0  bun scripts…s evidence ◆  │ │just test-mod",
    "  10:20  TEST     ✓ 0  curl -H 'Au… just test ◆  │ │(fail) the ledger draws",
    "❯ 10:00  TEST     ✗ 1  just test-mod          ◆  │ │  expected 3",
    "── Thu 2026-10-01 ── ████████ 1/2 ─────────────  │ │  received 4",
    "  09:30  LINT     ✗ 1  just lint              ◆  │ │at ledger.test.ts:40",
    "  09:00  BUILD    ✓ 0  bun run build          ◆  │ │1 fail",
    "                                                 │ │41 pass",
    "                                                 │ │Ran 42 tests",
    "                                                 │ │exit 1",
    "                                                 │ │done",
    "                                                 │ │end",
    "                                                 │ 2026-10-02 10:00:00 · ◆ executor",
    "                                                 ╰",
  ]);
  expect(nodeByKey(await ui.drawn(), "detail-2")?.props).toMatchObject({ borderColor: "error", width: 41 });
  const split = nodeByKey(await ui.drawn(), "split");
  expect(kids(split ?? { type: "Box" }).map((column) => (isNode(column) ? column.props : undefined))).toEqual([
    { flexDirection: "column", width: 47 },
    { flexDirection: "column" },
  ]);
  await ui.unmount();
});

test("rows draw each type and exit in its own tone, the program bold, masks dim, and the agent in its identity color", async ($, on) => {
  world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_200);
  const tree = await ui.drawn();
  expect(runsOf(nodeByKey(tree, "entry-3"))).toEqual([
    { text: "  " },
    { text: "10:20 ", color: "inactive" },
    { text: " TEST   ", color: "inverseText", backgroundColor: "permission", bold: true },
    { text: " " },
    { text: " ✓ 0 ", color: "inverseText", backgroundColor: "success", bold: true },
    { text: " " },
    { text: "curl", bold: true },
    { text: " -H 'Authorization: B….example/run && just test" },
    { text: " ◆ executor", color: "green_FOR_SUBAGENTS_ONLY" },
  ]);
  expect(nodeByKey(tree, "entry-3")?.props).toEqual({ key: "entry-3", flexDirection: "row" });
  const chips = (key: string) => runsOf(nodeByKey(tree, key)).filter((run) => run.backgroundColor !== undefined);
  expect(chips("entry-0").map((run) => [run.text, run.backgroundColor])).toEqual([[" BUILD  ", "claude"], [" ✓ 0 ", "success"]]);
  expect(chips("entry-1").map((run) => [run.text, run.backgroundColor])).toEqual([[" LINT   ", "warning"], [" ✗ 1 ", "error"]]);
  expect(chips("entry-4").map((run) => [run.text, run.backgroundColor])).toEqual([[" MANUAL ", "inactive"], [" ✓ 0 ", "success"]]);
  expect(chips("entry-5").map((run) => [run.text, run.backgroundColor])).toEqual([[" FINAL  ", "planMode"], [" ✓ 0 ", "success"]]);
  expect(runsOf(nodeByKey(tree, "entry-1")).at(-1)).toEqual({ text: " ◆ explore ", color: "blue_FOR_SUBAGENTS_ONLY" });
  expect(nodeByKey(tree, "entry-5")?.props).toEqual({ key: "entry-5", flexDirection: "row", backgroundColor: "selectionBg" });
  expect(runsOf(nodeByKey(tree, "entry-5")).at(-1)).toEqual({ text: " ◆ sisyphus", color: "text", bold: true });

  await $.ui.scroll({ ...SCROLL, by: 2, bodyRows: 46, contentRows: 47 });
  const opened = await ui.drawn();
  const command = runsOf(nodeByKey(opened, "entry-3")).slice(6, 8);
  expect(command).toEqual([
    { text: "curl", color: "text", bold: true },
    { text: " -H 'Authorization: B….example/run && just test", color: "text", bold: true },
  ]);
  const meta = kids(nodeByKey(opened, "detail-3") ?? { type: "Box" }).at(-1);
  expect(lines(meta)).toEqual(["2026-10-02 10:20:00 · ◆ executor · ‹masked› 2 masked"]);
  expect(isNode(meta) ? kids(meta).map((piece) => (isNode(piece) ? piece.props?.["color"] : undefined)) : []).toEqual([
    "inactive",
    "inactive",
    "green_FOR_SUBAGENTS_ONLY",
    "inactive",
    "warning",
  ]);
  await ui.unmount();
});

test("a mask inside a row's command is drawn dim", async ($, on) => {
  world(on, { ...(await proofFiles()), [LEDGER]: JSON.stringify({ entries: [evidence("test", `TOKEN=${TOKEN} just test`, 0, local(2, 9, 0), "executor", "ok")] }) });
  const ui = await openEvidence($, INLINE_80);
  expect(runsOf(nodeByKey(await ui.drawn(), "entry-0")).slice(6, 9)).toEqual([
    { text: "TOKEN=", color: "text", bold: true },
    { text: "‹masked›", color: "text", bold: true },
    { text: " just test", color: "text", bold: true },
  ]);
  await ui.press({ key: "f" });
  await ui.unmount();
});

test("the verdict reads complete, stale, missing, with no plan, or with an unreadable plan", async ($, on) => {
  const w = world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_120);
  const card = async () => lines(nodeByKey(await ui.drawn(), "verdict")).slice(1, 4);
  const border = async () => nodeByKey(await ui.drawn(), "verdict")?.props?.["borderColor"];
  const refresh = () => w.clock.advance(2000);

  expect(await card()).toEqual(["│ FINAL VERIFICATION · sample", "│  COMPLETE  matches the plan as it is now", "│ 10-02 11:45 · ◆ sisyphus"]);
  expect(await border()).toBe("success");

  write(w, PLAN_PATH, `${PLAN_TEXT}- [ ] 2. Added after the verification\n`);
  await refresh();
  expect(await card()).toEqual(["│ FINAL VERIFICATION · sample", "│  STALE  the plan changed after it passed", "│ 10-02 11:45"]);
  expect(await border()).toBe("warning");

  const failed = evidence("final_verification", "just ci", 1, local(2, 12, 0), "sisyphus", "INCOMPLETE", "f".repeat(64));
  write(w, LEDGER, JSON.stringify({ entries: [...runs("e".repeat(64)).filter((entry) => entry.type !== "final_verification"), failed] }));
  await refresh();
  expect(await card()).toEqual(["│ FINAL VERIFICATION · sample", "│  MISSING  no passing final verification", "│ the last one exited 1 at 10-02 12:00"]);
  expect(await border()).toBe("error");

  write(w, LEDGER, JSON.stringify({ entries: runs("").slice(0, 2) }));
  await refresh();
  expect(await card()).toEqual(["│ FINAL VERIFICATION · sample", "│  MISSING  no passing final verification", "│ ●✗ last 2  build 1  lint 1 ✗1"]);

  w.files.delete(PLAN_PATH);
  await refresh();
  expect(await card()).toEqual([
    "│ FINAL VERIFICATION · sample",
    "│  UNKNOWN  Could not read the plan file: ENOENT…",
    "│ ●✗ last 2  build 1  lint 1 ✗1",
  ]);
  expect(await border()).toBe("warning");

  write(w, BOULDER, JSON.stringify({ plans: {}, bindings: {} }));
  await refresh();
  expect(await card()).toEqual(["│ FINAL VERIFICATION", "│  NO PLAN  no plan is bound to this session", "│ ●✗ last 2  build 1  lint 1 ✗1"]);
  expect(await border()).toBe("inactive");
  await ui.unmount();
});

test("loading, an empty ledger, and an unreadable ledger each say so", async ($, on) => {
  const atoms = resettableState(on);
  const w = world(on, { [PLAN_PATH]: PLAN_TEXT, [BOULDER]: BOUND });
  const ui = await openEvidence($, DOCK_120);
  expect(await body(ui, DOCK_120)).toEqual([
    "╭",
    "│ FINAL VERIFICATION · sample",
    "│  MISSING  no passing final verification",
    "╰",
    "No verification evidence has been logged here yet.",
  ]);

  atoms.reset("ledger");
  await ui.redraw();
  expect(await body(ui, DOCK_120)).toEqual(["Reading the evidence ledger…"]);

  write(w, LEDGER, '{"entries": [');
  await w.clock.advance(2000);
  await ui.redraw();
  const [error, ...why] = await body(ui, DOCK_120);
  expect(error).toMatch(/^✗ Could not read \.omca\/evidence\/verification-evidence\.json: \S/);
  expect((await ui.find({ type: "Text", text: /^✗ Could not read/ }))?.props).toEqual({ color: "error", wrap: "wrap" });
  expect(why).toEqual(["evidence_log refuses to write to it until it parses again, and no verdict can be read from it."]);

  write(w, LEDGER, '{"items": []}');
  await w.clock.advance(2000);
  await ui.redraw();
  expect((await body(ui, DOCK_120))[0]).toBe("✗ Could not read .omca/evidence/verification-evidence.json: it holds no entries list");
  await ui.unmount();
});

const entryRows = async (ui: Mounted) => lines(await ui.drawn()).filter((row) => /^[❯ ] \d\d:\d\d /.test(row));
const statusRow = async (ui: Mounted) => (await body(ui, DOCK_120)).at(-2);

test("a type key keeps that type, again clears it, x keeps failures, and an empty match says so", async ($, on) => {
  world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_120);
  const dim = async (key: string) => (await ui.find({ key }))?.props["dimColor"] === true;

  expect(await Promise.all(["b", "e", "l", "m", "v", "x"].map(dim))).toEqual([true, true, true, true, true, true]);
  await ui.press({ key: "e" });
  expect((await entryRows(ui)).map((row) => row.slice(9, 15))).toEqual(["TEST  ", "TEST  "]);
  expect(await statusRow(ui)).toBe("1/2 · test only · ↑↓ move");
  expect(await dim("e")).toBe(false);

  await ui.press({ key: "x" });
  expect((await entryRows(ui)).map((row) => row.slice(0, 26))).toEqual(["❯ 10:00  TEST     ✗ 1  jus"]);
  expect(await statusRow(ui)).toBe("1/1 · test only · failures only · ↑↓ move");

  await ui.press({ key: "e" });
  expect((await entryRows(ui)).map((row) => row.slice(0, 22))).toEqual(["❯ 10:00  TEST     ✗ 1 ", "  09:30  LINT     ✗ 1 "]);
  expect(await statusRow(ui)).toBe("1/2 · failures only · ↑↓ move");

  await ui.press({ key: "b" });
  expect(await entryRows(ui)).toEqual([]);
  expect((await body(ui, DOCK_120)).slice(7, 8)).toEqual(["No entry matches the filter. Press its key again to clear it."]);
  expect((await ui.find({ type: "Text", text: /^No entry matches/ }))?.props).toEqual({ dimColor: true, wrap: "wrap" });
  expect(await statusRow(ui)).toBe("x: Fails  f: Find  0/6 · nothing matches");
  expect(await ui.find({ key: "c" })).toBeUndefined();

  await ui.press({ key: "x" });
  expect((await entryRows(ui)).map((row) => row.slice(9, 15))).toEqual(["BUILD "]);
  await ui.press({ key: "b" });
  for (const [key, label] of [["l", "LINT  "], ["m", "MANUAL"], ["v", "FINAL "]] as const) {
    await ui.press({ key });
    expect((await entryRows(ui)).map((row) => row.slice(9, 15)), key).toEqual([label]);
    await ui.press({ key });
  }
  expect(await entryRows(ui)).toHaveLength(6);
  await ui.unmount();
});

test("the arrows move the focus one entry, a page key a window, Home and End to the ends, and the engine is left alone", async ($, on) => {
  const handed: number[] = [];
  on("ui.scroll", (_$, e) => (handed.push(e.by), {}));
  const entries = Array.from({ length: 600 }, (_, n) =>
    evidence(n % 7 === 0 ? "lint" : "test", `just test shard-${n}`, n % 5 === 0 ? 1 : 0, new Date(2026, 9, 2, 0, 0, n).toISOString(), "executor", `shard ${n}`),
  );
  world(on, { [PLAN_PATH]: PLAN_TEXT, [BOULDER]: BOUND, [LEDGER]: JSON.stringify({ entries }) });
  const ui = await openEvidence($, DOCK_120);
  const scroll = (by: number) => $.ui.scroll({ ...SCROLL, by, bodyRows: 36, contentRows: 37 });
  const focusedRow = async () => (await entryRows(ui)).find((row) => row.startsWith("❯"))?.slice(23, 49).trimEnd();

  expect(await body(ui, DOCK_120)).toHaveLength(34);
  expect(await entryRows(ui)).toHaveLength(20);
  expect(await focusedRow()).toBe("just test shard-599");
  expect(await statusRow(ui)).toBe("1/600 · ↑↓ move");

  await scroll(1);
  expect(await focusedRow()).toBe("just test shard-598");
  await scroll(36);
  expect(await focusedRow()).toBe("just test shard-578");
  expect(await statusRow(ui)).toBe("22/600 · ↑↓ move");
  await scroll(-1);
  expect(await focusedRow()).toBe("just test shard-579");
  await scroll(37);
  expect(await focusedRow()).toBe("just test shard-0");
  expect(await statusRow(ui)).toBe("600/600 · ↑↓ move");
  expect((await entryRows(ui)).at(-1)).toStartWith("❯ 00:00  LINT     ✗ 1  just test shard-0");
  await scroll(1);
  expect(await focusedRow()).toBe("just test shard-0");
  await scroll(-37);
  expect(await focusedRow()).toBe("just test shard-599");
  expect(handed).toEqual([]);
  await ui.unmount();
});

test("c copies the focused command as drawn, masks and all, and r fills a rerun request without sending it", async ($, on) => {
  const copies: [string, unknown][] = [];
  const fills: string[] = [];
  on("ui.copy", (_$, e) => (copies.push([e.text, e.surface]), { value: { isCopied: true } }));
  on("prompt.fill", (_$, e) => (fills.push(e.text), { isFilled: true }));
  on("prompt.submit", () => {
    throw new Error("the Evidence tab must never submit");
  });
  world(on, { ...(await proofFiles()), [LEDGER]: JSON.stringify({ entries: runs(await sha256Hex(PLAN_TEXT)).map((entry, index) => (index === 3 ? { ...entry, command: `${entry.command} --home /home/u/project` } : entry)) }) });
  const ui = await openEvidence($, DOCK_120);

  await $.ui.scroll({ ...SCROLL, by: 2, bodyRows: 36, contentRows: 37 });
  await ui.press({ key: "c" });
  expect(copies).toEqual([["curl -H 'Authorization: Bearer ‹masked›' https://ci.example/run && just test --home ~/project", "terminal"]]);
  expect(await statusRow(ui)).toBe("3/6 · ↑↓ move · copied the command");

  await ui.press({ key: "r" });
  expect(fills).toEqual([
    "Run `curl -H 'Authorization: Bearer ‹masked›' https://ci.example/run && just test --home ~/project` again and log the result with evidence_log as test evidence.",
  ]);
  await $.ui.scroll({ ...SCROLL, by: -2, bodyRows: 36, contentRows: 37 });
  expect(await statusRow(ui)).toBe("x: Fails  c: Copy  r: Rerun  f: Find  1/6 · ↑↓ move");
  await ui.press({ key: "r" });
  expect(fills.at(-1)).toBe(
    `Run the final verification again (\`just ci\`) and log the verdict with evidence_log as final_verification evidence with plan_sha256="${await sha256Hex(PLAN_TEXT)}".`,
  );
  await ui.unmount();
});

test("a copy the surface refuses says why", async ($, on) => {
  on("ui.copy", () => ({ value: { isCopied: false, reason: "no-clipboard" } }));
  world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_120);
  await ui.press({ key: "c" });
  expect(await statusRow(ui)).toBe("1/6 · ↑↓ move · could not copy: no-clipboard");
  await ui.unmount();
});

test("s opens the search field and moves the focus to it; typing filters, and submitting it empty closes it", async ($, on) => {
  const w = world(on, await proofFiles());
  const ui = await openEvidence($, DOCK_120);
  expect(await ui.find({ key: "search" })).toBeUndefined();

  await ui.press({ key: "f" });
  await w.clock.settle();
  expect((await body(ui, DOCK_120)).at(-2)).toBe("[search command, agent or type]");
  expect(w.logs.at(-1)).toBe("omca evidence could not focus the search: no implementation for ui.focus");

  await ui.input({ key: "search", text: "JUST TEST", kind: "change" });
  expect((await entryRows(ui)).map((row) => row.slice(9, 15))).toEqual(["TEST  ", "TEST  "]);
  expect((await body(ui, DOCK_120)).at(-3)).toBe('1/2 · "JUST TEST" · ↑↓ move');
  expect(await ui.find({ key: "f" })).toMatchObject({ props: { label: "Find" } });
  expect((await ui.find({ key: "f" }))?.props["dimColor"]).toBeUndefined();

  await ui.input({ key: "search", text: "explore" });
  expect((await entryRows(ui)).map((row) => row.slice(9, 15))).toEqual(["LINT  "]);
  await ui.input({ key: "search", text: "" });
  expect(await ui.find({ key: "search" })).toBeUndefined();
  expect(await entryRows(ui)).toHaveLength(6);
  await ui.unmount();
});

test("OMCA_ASCII draws the Evidence tab from the ASCII set", async ($, on) => {
  world(on, await proofFiles(), {}, { OMCA_ASCII: "1" });
  const ui = await openEvidence($, INLINE_80);
  expect(await body(ui, INLINE_80)).toEqual([
    "[COMPLETE] sample  oxxooo last 6  10-02 11:45  @ sisyphus  build 1 ...",
    "-- Fri 2026-10-02 -- [#####.] 3/4 ---------------------------------------",
    "> 11:45 [FINAL ] [+ 0] just ci                                 @ sisyphus",
    "    │COMPLETE",
    "    2026-10-02 11:45:00 - @ sisyphus",
    "  11:00 [MANUAL] [+ 0] bun scripts/qa/visual.ts evidence       @ sisyphus",
    "  10:20 [TEST  ] [+ 0] curl -H 'Authoriza...e/run && just test @ executor",
    "  10:00 [TEST  ] [x 1] just test-mod                           @ executor",
    "b: Build  e: Test  l: Lint  m: Manual  v: Final  x: Fails  c: Copy",
    "r: Rerun  f: Find  1/6 - ^v move",
    " ",
  ]);
  const isAscii = (row: string) => [...row].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) < 127);
  await $.ui.scroll({ ...SCROLL, by: 2, bodyRows: 10, contentRows: 11 });
  const drawn = (await body(ui, INLINE_80)).map((row) => row.replace(/[│╭╰]/g, ""));
  expect(drawn.filter((row) => !isAscii(row))).toEqual([]);
  expect(await ui.find({ type: "Text", text: /<masked> 2 masked/ })).toBeDefined();
  await ui.unmount();
});

test("Evidence rows stay inside the body less the gutter at every size, docked and inline, on both surfaces", async ($, on) => {
  const long = evidence("manual", `bun scripts/qa/visual.ts ${"evidence ".repeat(30)}`, 127, local(2, 12, 0), "oh-my-claudeagent:multimodal-looker", "x".repeat(400));
  world(on, { ...(await proofFiles()), [LEDGER]: JSON.stringify({ entries: [...runs(""), long] }) });
  await $.command.run(run(""));
  for (const size of [...SIZES, DOCK_210]) {
    for (const surface of SURFACES) {
      const room = usableColumns(bodyColumns(size));
      const ui = await $.ui.mount(pane(surface, size));
      await ui.press({ key: "3" });
      for (const searching of [false, true]) {
        if (searching) await ui.press({ key: "f" });
        for (const child of topRows(await ui.drawn())) {
          expect(cellsAcross(child), `${size.columns} ${size.placement} ${surface}`).toBeLessThanOrEqual(room);
        }
      }
      await ui.unmount();
    }
  }
});
