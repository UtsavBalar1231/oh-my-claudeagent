import type { On, SessionRateLimit, TurnUsage } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { displayWidth } from "../../src/core/ui-kit.ts";
import { LEDGER, ROOT, SESSION, type World, world } from "./world.ts";

const STATUS = `${ROOT}/.omca/state/session/${SESSION}.json`;
const STARTED_MS = Date.UTC(2026, 9, 2, 12, 0, 0);
const STARTED_S = STARTED_MS / 1000;
const LONG = "bun test src servers statusline scripts opencode --timeout 60000 --bail --reporter=junit";

const USAGE: TurnUsage = {
  input_tokens: 10_000,
  cache_read_input_tokens: 2_000,
  cache_creation_input_tokens: 345,
  output_tokens: 845,
  model: "claude-opus-5-5",
};

type Meter = { usd: number | undefined; rateLimits: SessionRateLimit[] };

function engine(on: On, files: Readonly<Record<string, string>> = {}, env: Readonly<Record<string, string>> = {}) {
  const w = world(on, files, {}, env);
  const meter: Meter = { usd: 0.25, rateLimits: [] };
  on("session.usage", () => ({
    value: {
      startedAt: STARTED_MS,
      context: { window: 200_000 },
      rateLimits: meter.rateLimits,
      ...(meter.usd === undefined ? {} : { cost: { usd: meter.usd } }),
    },
  }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  return { w, meter };
}

const statusFile = (command: string, at: number) =>
  JSON.stringify({ session_id: SESSION, last_hook_at: at, verification: { command, at, exit_code: 0, evidence_logged: false } });

function ledgerAt(w: World, seconds: number): void {
  w.files.set(LEDGER, { text: JSON.stringify({ entries: [] }), mtimeMs: seconds * 1000 });
}

async function turn($: Engine, w: World, meter: Meter, usd: number | undefined, agentId?: string) {
  await w.clock.advance(4_200);
  meter.usd = usd;
  return $.turn.complete({
    answer: "The tests ran.",
    durationMs: 4_200,
    isAborted: false,
    turnId: "t-1",
    reason: "answer",
    usage: USAGE,
    ...(agentId === undefined ? {} : { agentId }),
  });
}

test("a main turn ends with its duration, tokens and the engine's cost since it started", async ($, on) => {
  const { w, meter } = engine(on);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: "4s · 12.3k in 845 out · $0.0312 engine cost" });
});

for (const kind of ["five_hour", "seven_day"]) {
  test(`a subscription's ${kind} window leaves the cost out`, async ($, on) => {
    const { w, meter } = engine(on);
    meter.rateLimits = [{ kind, percentUsed: 23.5 }];
    await $.turn.start({ text: "Run the tests", turnId: "t-1" });

    expect(await turn($, w, meter, 0.2812)).toEqual({ text: "4s · 12.3k in 845 out" });
  });
}

test("a gateway's spend limit alone keeps the cost", async ($, on) => {
  const { w, meter } = engine(on);
  meter.rateLimits = [{ kind: "spend_limit", percentUsed: 62.8 }];
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: "4s · 12.3k in 845 out · $0.0312 engine cost" });
});

test("a verification this turn that the ledger has not caught up with is named in the footer", async ($, on) => {
  const { w, meter } = engine(on, { [STATUS]: statusFile("just test", STARTED_S + 2) });
  ledgerAt(w, STARTED_S - 600);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812)).toEqual({
    text: "4s · 12.3k in 845 out · ! no evidence: just test",
  });
});

test("a verification logged after it ran raises no warning", async ($, on) => {
  const { w, meter } = engine(on, { [STATUS]: statusFile("just test", STARTED_S + 2) });
  ledgerAt(w, STARTED_S + 3);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: "4s · 12.3k in 845 out · $0.0312 engine cost" });
});

test("a verification from before the turn started raises no warning", async ($, on) => {
  const { w, meter } = engine(on, { [STATUS]: statusFile("just test", STARTED_S - 1) });
  ledgerAt(w, STARTED_S - 600);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: "4s · 12.3k in 845 out · $0.0312 engine cost" });
});

test("a status file that does not parse leaves the warning out, and the reason goes to the debug log", async ($, on) => {
  const { w, meter } = engine(on, { [STATUS]: "{ not json" });
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: "4s · 12.3k in 845 out · $0.0312 engine cost" });
  expect(w.logs.filter((line) => line.startsWith("footer: cannot check this turn's verification: "))).toHaveLength(1);
});

test("a subagent's turn.complete gets no footer and the engine's answer stands", async ($, on) => {
  const { w, meter } = engine(on, { [STATUS]: statusFile("just test", STARTED_S + 2) });
  await $.turn.start({ text: "Delegate", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812, "a-1")).toEqual({ text: "The tests ran." });
});

test("without a cost sample the footer leaves the cost out", async ($, on) => {
  const { w, meter } = engine(on);

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: "4s · 12.3k in 845 out" });
});

test("without a cost sample the turn is dated from its duration", async ($, on) => {
  const inside = engine(on, { [STATUS]: statusFile("just test", STARTED_S + 2) });
  expect(await turn($, inside.w, inside.meter, 0.2812)).toEqual({ text: "4s · 12.3k in 845 out · ! no evidence: just test" });

  inside.w.files.set(STATUS, { text: statusFile("just test", STARTED_S + 3), mtimeMs: 0 });
  expect(await turn($, inside.w, inside.meter, 0.2812)).toEqual({ text: "4s · 12.3k in 845 out" });
});

test("a host that keeps no cost ledger leaves the cost out", async ($, on) => {
  const { w, meter } = engine(on);
  meter.usd = undefined;
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, undefined)).toEqual({ text: "4s · 12.3k in 845 out" });
});

for (const [glyphSet, env, line] of [
  ["Unicode", {}, "4s · 12.3k in 845 out · ! no evidence: bun test sr…"],
  ["ASCII", { OMCA_GLYPHS: "ascii" }, "4s - 12.3k in 845 out - ! no evidence: bun test..."],
] as const) {
  test(`the footer is one line that keeps to one row of an 80-column terminal, in the ${glyphSet} glyph set`, async ($, on) => {
    const { w, meter } = engine(on, { [STATUS]: statusFile(LONG, STARTED_S + 2) }, env);
    await $.turn.start({ text: "Run the tests", turnId: "t-1" });
    const { text } = await turn($, w, meter, 0.2812);

    expect(text).toBe(line);
    expect(displayWidth(`● oh-my-claudeagent: ${text}`)).toBeLessThanOrEqual(72);
  });
}
