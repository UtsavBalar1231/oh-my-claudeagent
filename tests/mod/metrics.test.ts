import type { Args, On } from "claude-code";
import { expect, test } from "claude-code/testing";
import type { MetricsRecord } from "../../src/core/metrics.ts";
import { drain, LEDGER, pane, ROOT, run, spreadRows, usage, type World, world, write } from "./world.ts";

const METRICS = `${ROOT}/.omca/metrics`;
const SURFACES = ["terminal", "desktop"] as const;

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
    "oh-my-claudeagent:explorer": ["claude-haiku-4-5", "a-2"],
    "oh-my-claudeagent:architect": ["claude-fable-5-1", "../escape"],
  };
  on("agent.spawn", (_$, e) => {
    const [model, agentId] = models[e.subagentType] ?? ["claude-opus-5-5", "a-9"];
    return { model, agentId };
  });
  on("turn.step", async function* (_$, e) {
    const counted = e.agentId === "a-1" ? usage(2000, 500, "claude-sonnet-5-5", 10_000, 1000) : null;
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: counted };
  });
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  return { w, writes };
}

const evidenceAt = (...timestamps: string[]) =>
  JSON.stringify({ entries: timestamps.map((timestamp) => ({ type: "test", command: "just test", exit_code: 0, output_snippet: "ok", timestamp })) });

test("each delegation is written running at spawn and overwritten once when its turn completes or aborts", async ($, on) => {
  const { w, writes } = engine(on, { [LEDGER]: evidenceAt("2026-10-02T12:00:15Z") });
  w.surfaces = [];

  await $.agent.spawn(spawn("oh-my-claudeagent:executor", "Fix the parser"));
  await w.clock.advance(30_000);
  await $.agent.spawn(spawn("oh-my-claudeagent:explorer", "Find the callers"));
  const running1: MetricsRecord = {
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
  const running2: MetricsRecord = {
    ...running1,
    agent_id: "a-2",
    agent_type: "oh-my-claudeagent:explorer",
    model: "claude-haiku-4-5",
    started_at: "2026-10-02T12:00:30.000Z",
  };
  expect(writes).toEqual([
    [`${METRICS}/s1/a-1.json`, running1],
    [`${METRICS}/s1/a-2.json`, running2],
  ]);

  await drain($.turn.step({ turnId: "t-a-1", index: 0, model: "claude-sonnet-5-5", effort: "high", messageCount: 1, agentId: "a-1" }));
  await drain($.turn.step({ turnId: "t-a-2", index: 0, model: "claude-haiku-4-5", messageCount: 1, agentId: "a-2" }));
  await w.clock.advance(60_000);
  await $.turn.complete(complete("a-1", { answer: "Fixed the parser.", durationMs: 90_000, usage: usage(2000, 500, "claude-sonnet-5-5", 10_000, 1000) }));
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
    expect(spreadRows(await ui.drawn()).slice(3)).toEqual([
      "2 delegations in 1 session",
      "Agents · 2 types",
      "  agent     runs  est. cost  evidence",
      "◆ executor     1      $0.01    ✓ 100%",
      "◆ explorer     1      $0.00      ✗ 0%",
      "Tokens per turn · 2 turns",
      "█▁ peak 13.5k",
      "Estimated cost",
      `$0.01 ${"█".repeat(41)}`,
      "◆ executor $0.01",
      "2026-10-02 list prices",
      "r: Reload",
    ]);
    await ui.unmount();
  }
});

test("a turn that reports no usage after its steps counted tokens leaves the cost unpriced, not zero", async ($, on) => {
  const { w, writes } = engine(on);
  await $.agent.spawn(spawn("oh-my-claudeagent:executor", "Fix the parser"));
  await drain($.turn.step({ turnId: "t-a-1", index: 0, model: "claude-sonnet-5-5", messageCount: 1, agentId: "a-1" }));
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

test("a ledger that does not parse records evidence_logged as unknown, and says why", async ($, on) => {
  const { w, writes } = engine(on, { [LEDGER]: "{ not json" });
  await $.agent.spawn(spawn("oh-my-claudeagent:executor", "Fix the parser"));
  await w.clock.advance(1_000);
  await $.turn.complete(complete("a-1", { answer: "Fixed." }));

  expect(writes.at(-1)?.[1]).toMatchObject({ outcome: "completed", evidence_logged: null });
  expect(w.logs.filter((line) => line.startsWith("metrics: could not read"))).toHaveLength(1);
});

test("an unsafe agent id names no file and writes nothing", async ($, on) => {
  const { w, writes } = engine(on);
  await $.agent.spawn(spawn("oh-my-claudeagent:architect", "Review"));
  expect(writes).toEqual([]);
  expect(w.logs).toContain('metrics: no record for session "s1" agent "../escape"');
});

test("a teammate writes no delegation record at spawn or when its turn completes", async ($, on) => {
  const { writes } = engine(on);
  await $.agent.spawn({ ...spawn("oh-my-claudeagent:executor", "Fix the parser"), isTeammate: true });
  await $.turn.complete(complete("a-1", { answer: "Fixed." }));
  expect(writes).toEqual([]);
});
