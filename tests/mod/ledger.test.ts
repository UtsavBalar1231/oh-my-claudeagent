import type { Args, On, TurnUsage } from "claude-code";
import { expect, test } from "claude-code/testing";
import type { LedgerRecord } from "../../src/core/ledger.ts";
import { usableColumns } from "../../src/core/ui-kit.ts";
import { bodyColumns, cellsAcross, LEDGER, pane, ROOT, rows, run, SIZES, topRows, type World, world, write } from "./world.ts";

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
