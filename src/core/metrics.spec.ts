import { describe, expect, test } from "bun:test";
import {
  aggregate,
  isEvidenceLogged,
  type MetricsRecord,
  median,
  outcomeOf,
  parseRecord,
  parseRecords,
  recordPath,
} from "./metrics.ts";

const START = Date.parse("2026-10-02T12:00:00.000Z");
const END = Date.parse("2026-10-02T12:05:00.000Z");

function record(fields: Partial<MetricsRecord> = {}): MetricsRecord {
  return {
    session_id: "s1",
    agent_id: "a-1",
    agent_type: "oh-my-claudeagent:executor",
    model: "claude-sonnet-5-5",
    effort: "high",
    started_at: "2026-10-02T12:00:00.000Z",
    ended_at: "2026-10-02T12:05:00.000Z",
    duration_ms: 300_000,
    input_tokens: 1000,
    output_tokens: 100,
    estimated_cost_usd: 0.003,
    outcome: "completed",
    evidence_logged: true,
    ...fields,
  };
}

const ledger = (...timestamps: unknown[]) =>
  JSON.stringify({ entries: timestamps.map((timestamp) => ({ type: "test", command: "just test", exit_code: 0, timestamp })) });

describe("outcomeOf", () => {
  test.each([
    [{ isAborted: false, answer: "Fixed the parser." }, "completed"],
    [{ isAborted: true, answer: "Fixed half of it" }, "aborted"],
    [{ isAborted: true, answer: "" }, "aborted"],
    [{ isAborted: false, answer: "" }, "empty"],
    [{ isAborted: false, answer: " \n\t" }, "empty"],
  ] as const)("%j is %s", (turn, outcome) => {
    expect(outcomeOf(turn)).toBe(outcome);
  });
});

describe("isEvidenceLogged", () => {
  test.each([
    ["exactly at the start", "2026-10-02T12:00:00.000Z", true],
    ["exactly at the end", "2026-10-02T12:05:00.000Z", true],
    ["inside", "2026-10-02T12:02:30Z", true],
    ["a millisecond before the start", "2026-10-02T11:59:59.999Z", false],
    ["a millisecond after the end", "2026-10-02T12:05:00.001Z", false],
  ])("an entry %s: %p", (_, timestamp, expected) => {
    expect(isEvidenceLogged(ledger(timestamp), START, END)).toBe(expected);
  });

  test("an entry without a parseable timestamp never counts, and one inside does", () => {
    expect(isEvidenceLogged(ledger("yesterday", null, 12), START, END)).toBe(false);
    expect(isEvidenceLogged(ledger("yesterday", "2026-10-02T12:01:00Z"), START, END)).toBe(true);
  });

  test("an entry the evidence parser cannot read never counts, even inside the window", () => {
    const text = JSON.stringify({ entries: [{ type: "deploy", command: "x", exit_code: 0, timestamp: "2026-10-02T12:01:00Z" }] });
    expect(isEvidenceLogged(text, START, END)).toBe(false);
  });

  test("an empty ledger is no evidence, and a ledger without an entries list throws", () => {
    expect(isEvidenceLogged(ledger(), START, END)).toBe(false);
    expect(() => isEvidenceLogged("{}", START, END)).toThrow("it holds no entries list");
    expect(() => isEvidenceLogged("{", START, END)).toThrow();
  });
});

describe("recordPath", () => {
  test("names one file per delegation under the session's directory", () => {
    expect(recordPath("/work", "00000000-0000-4000-8000-000000000001", "a1b2c3")).toBe(
      "/work/.omca/metrics/00000000-0000-4000-8000-000000000001/a1b2c3.json",
    );
  });

  test.each([
    ["../s1", "a-1"],
    ["s1", "../../etc/passwd"],
    ["s1", "a/1"],
    ["", "a-1"],
    ["s1", ""],
    ["s1", "-a"],
    ["s1", "a".repeat(129)],
    ["s1", "nul"],
    ["s1", "COM1"],
    ["CON", "a-1"],
  ])("refuses session %p agent %p", (sessionId, agentId) => {
    expect(recordPath("/work", sessionId, agentId)).toBeUndefined();
  });
});

describe("parseRecord", () => {
  test("reads a running and a finished record back exactly", () => {
    const running = record({ ended_at: null, duration_ms: null, input_tokens: 0, output_tokens: 0, estimated_cost_usd: null, outcome: "running", evidence_logged: null });
    expect(parseRecord(JSON.stringify(running))).toEqual(running);
    expect(parseRecord(JSON.stringify(record()))).toEqual(record());
  });

  test.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["an unknown outcome", JSON.stringify(record({ outcome: "done" as MetricsRecord["outcome"] }))],
    ["a missing agent type", JSON.stringify({ ...record(), agent_type: undefined })],
    ["negative tokens", JSON.stringify(record({ input_tokens: -1 }))],
    ["a fractional duration", JSON.stringify(record({ duration_ms: 1.5 }))],
    ["a bad start time", JSON.stringify(record({ started_at: "noon" }))],
    ["a cost given as text", JSON.stringify({ ...record(), estimated_cost_usd: "0.01" })],
  ])("skips %s", (_, text) => {
    expect(parseRecord(text)).toBeUndefined();
  });
});

test("parseRecords keeps the readable records and counts each unparseable or unread one as skipped", () => {
  expect(parseRecords([JSON.stringify(record()), "{", undefined, JSON.stringify(record({ agent_id: "a-2" }))])).toEqual({
    records: [record(), record({ agent_id: "a-2" })],
    skipped: 2,
  });
  expect(parseRecords([])).toEqual({ records: [], skipped: 0 });
});

describe("median", () => {
  test.each([
    [[], 0],
    [[7], 7],
    [[30, 10, 20], 20],
    [[40, 10, 30, 20], 25],
    [[1000, 2001], 1500.5],
  ])("of %j is %p", (values, expected) => {
    expect(median(values)).toBe(expected);
  });
});

describe("aggregate", () => {
  test("groups by agent type with exact totals, the median of finished runs and outcome counts", () => {
    const rows = aggregate([
      record({ agent_id: "e1", duration_ms: 60_000, input_tokens: 1200, output_tokens: 300, estimated_cost_usd: 0.0054, evidence_logged: true }),
      record({ agent_id: "e2", duration_ms: 120_000, input_tokens: 800, output_tokens: 200, estimated_cost_usd: 0.0036, outcome: "aborted", evidence_logged: false }),
      record({ agent_id: "e3", duration_ms: 30_000, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0, outcome: "empty", evidence_logged: null }),
      record({ agent_id: "e4", ended_at: null, duration_ms: null, input_tokens: 0, output_tokens: 0, estimated_cost_usd: null, outcome: "running", evidence_logged: null }),
      record({ agent_id: "o1", agent_type: "oh-my-claudeagent:architect", model: "claude-fable-5-1", duration_ms: 400_000, estimated_cost_usd: 0.1, evidence_logged: false }),
    ]);
    expect(rows).toEqual([
      {
        agentType: "oh-my-claudeagent:executor",
        count: 4,
        medianDurationMs: 60_000,
        inputTokens: 2000,
        outputTokens: 500,
        estimatedCostUsd: 0.009,
        unpriced: 0,
        outcomes: { running: 1, completed: 1, aborted: 1, empty: 1 },
        evidenceRate: 1 / 3,
      },
      {
        agentType: "oh-my-claudeagent:architect",
        count: 1,
        medianDurationMs: 400_000,
        inputTokens: 1000,
        outputTokens: 100,
        estimatedCostUsd: 0.1,
        unpriced: 0,
        outcomes: { running: 0, completed: 1, aborted: 0, empty: 0 },
        evidenceRate: 0,
      },
    ]);
  });

  // Four times the input takes about four to five times as long when the grouping is linear and
  // sorts once, and sixteen times as long when it is quadratic; 12 leaves room for a loaded runner.
  test("groups a long run of one agent type in linear time", () => {
    const fastest = (count: number): number => {
      const records = Array.from({ length: count }, (_, i) => record({ agent_id: `a${i}` }));
      aggregate(records);
      const times = Array.from({ length: 7 }, () => {
        const start = performance.now();
        aggregate(records);
        return performance.now() - start;
      });
      return Math.min(...times);
    };
    const small = fastest(15_000);
    const large = fastest(60_000);
    expect(large / Math.max(small, 0.5)).toBeLessThan(12);
    expect(aggregate(Array.from({ length: 60_000 }, (_, i) => record({ agent_id: `a${i}` })))[0]?.count).toBe(60_000);
  });

  test("sums costs without float drift: ten runs at $0.1 total exactly $1", () => {
    const rows = aggregate(Array.from({ length: 10 }, (_, i) => record({ agent_id: `a${i}`, estimated_cost_usd: 0.1 })));
    expect(rows[0]?.estimatedCostUsd).toBe(1);
  });

  test("an unpriced model's runs are counted, never priced, and a running record is not unpriced", () => {
    const rows = aggregate([
      record({ agent_id: "p1", estimated_cost_usd: 0.25 }),
      record({ agent_id: "u1", model: "mock-model", estimated_cost_usd: null }),
      record({ agent_id: "u2", model: "mock-model", estimated_cost_usd: null }),
      record({ agent_id: "r1", estimated_cost_usd: null, outcome: "running", ended_at: null, duration_ms: null, evidence_logged: null }),
      record({ agent_id: "x1", agent_type: "explorer", model: "mock-model", estimated_cost_usd: null }),
    ]);
    expect(rows.map((row) => [row.agentType, row.count, row.estimatedCostUsd, row.unpriced])).toEqual([
      ["oh-my-claudeagent:executor", 4, 0.25, 2],
      ["explorer", 1, 0, 1],
    ]);
  });

  test("a type with only running delegations has no median and no evidence rate", () => {
    const rows = aggregate([record({ outcome: "running", ended_at: null, duration_ms: null, estimated_cost_usd: null, evidence_logged: null })]);
    expect(rows[0]).toMatchObject({ count: 1, medianDurationMs: 0, evidenceRate: 0, unpriced: 0, outcomes: { running: 1, completed: 0, aborted: 0, empty: 0 } });
  });

  test("orders by run count, then by agent type", () => {
    const rows = aggregate([
      record({ agent_type: "b" }),
      record({ agent_type: "c", agent_id: "c1" }),
      record({ agent_type: "c", agent_id: "c2" }),
      record({ agent_type: "a" }),
    ]);
    expect(rows.map((row) => row.agentType)).toEqual(["c", "a", "b"]);
  });
});
