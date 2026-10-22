import type { On, SessionRateLimit, TurnUsage } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { displayWidth } from "../../src/core/ui-kit.ts";
import { LEDGER, PLUGIN, ROOT, SESSION, type World, world } from "./world.ts";

const STATUS = `${ROOT}/.omca/state/session/${SESSION}.json`;
const STARTED_MS = Date.UTC(2026, 9, 2, 12, 0, 0);
const STARTED_S = STARTED_MS / 1000;
const B = "\u00a0";
const LONG = "bun test src servers statusline scripts opencode --timeout 60000 --bail --reporter=junit";

const USAGE: TurnUsage = {
  input_tokens: 10_000,
  cache_read_input_tokens: 2_000,
  cache_creation_input_tokens: 345,
  output_tokens: 845,
  model: "claude-opus-5-5",
};

type Meter = { usd: number | undefined; rateLimits: SessionRateLimit[] };

// The text footer is what a session with no terminal gets; a terminal closes the turn with its own line.
function engine(on: On, files: Readonly<Record<string, string>> = {}, env: Readonly<Record<string, string>> = {}) {
  const w = world(on, files, {}, env);
  w.surfaces = ["desktop"];
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

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: `4s · 12.3k${B}in${B}845${B}out · $0.0312${B}engine${B}cost` });
});

for (const kind of ["five_hour", "seven_day"]) {
  test(`a subscription's ${kind} window leaves the cost out`, async ($, on) => {
    const { w, meter } = engine(on);
    meter.rateLimits = [{ kind, percentUsed: 23.5 }];
    await $.turn.start({ text: "Run the tests", turnId: "t-1" });

    expect(await turn($, w, meter, 0.2812)).toEqual({ text: `4s · 12.3k${B}in${B}845${B}out` });
  });
}

test("a gateway's spend limit alone keeps the cost", async ($, on) => {
  const { w, meter } = engine(on);
  meter.rateLimits = [{ kind: "spend_limit", percentUsed: 62.8 }];
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: `4s · 12.3k${B}in${B}845${B}out · $0.0312${B}engine${B}cost` });
});

test("a verification this turn that the ledger has not caught up with is named in the footer", async ($, on) => {
  const { w, meter } = engine(on, { [STATUS]: statusFile("just test", STARTED_S + 2) });
  ledgerAt(w, STARTED_S - 600);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812)).toEqual({
    text: `4s · 12.3k${B}in${B}845${B}out · !${B}no${B}evidence:${B}just${B}test`,
  });
});

test("a verification logged after it ran raises no warning", async ($, on) => {
  const { w, meter } = engine(on, { [STATUS]: statusFile("just test", STARTED_S + 2) });
  ledgerAt(w, STARTED_S + 3);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: `4s · 12.3k${B}in${B}845${B}out · $0.0312${B}engine${B}cost` });
});

test("a verification from before the turn started raises no warning", async ($, on) => {
  const { w, meter } = engine(on, { [STATUS]: statusFile("just test", STARTED_S - 1) });
  ledgerAt(w, STARTED_S - 600);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: `4s · 12.3k${B}in${B}845${B}out · $0.0312${B}engine${B}cost` });
});

test("a status file that does not parse leaves the warning out, and the reason goes to the debug log", async ($, on) => {
  const { w, meter } = engine(on, { [STATUS]: "{ not json" });
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: `4s · 12.3k${B}in${B}845${B}out · $0.0312${B}engine${B}cost` });
  expect(w.logs.filter((line) => line.startsWith("footer: cannot check this turn's verification: "))).toHaveLength(1);
});

test("a subagent's turn.complete gets no footer and the engine's answer stands", async ($, on) => {
  const { w, meter } = engine(on, { [STATUS]: statusFile("just test", STARTED_S + 2) });
  await $.turn.start({ text: "Delegate", turnId: "t-1" });

  expect(await turn($, w, meter, 0.2812, "a-1")).toEqual({ text: "The tests ran." });
});

test("a subagent's turn.start leaves the main turn's cost sample alone", async ($, on) => {
  const { w, meter } = engine(on);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });
  meter.usd = 0.5;
  await $.turn.start({ text: "Delegate", turnId: "t-2", agentId: "a1" });

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: `4s · 12.3k${B}in${B}845${B}out · $0.0312${B}engine${B}cost` });
});

test("without a cost sample the footer leaves the cost out", async ($, on) => {
  const { w, meter } = engine(on);

  expect(await turn($, w, meter, 0.2812)).toEqual({ text: `4s · 12.3k${B}in${B}845${B}out` });
});

test("without a cost sample the turn is dated from its duration", async ($, on) => {
  const inside = engine(on, { [STATUS]: statusFile("just test", STARTED_S + 2) });
  expect(await turn($, inside.w, inside.meter, 0.2812)).toEqual({ text: `4s · 12.3k${B}in${B}845${B}out · !${B}no${B}evidence:${B}just${B}test` });

  inside.w.files.set(STATUS, { text: statusFile("just test", STARTED_S + 3), mtimeMs: 0 });
  expect(await turn($, inside.w, inside.meter, 0.2812)).toEqual({ text: `4s · 12.3k${B}in${B}845${B}out` });
});

test("a host that keeps no cost ledger leaves the cost out", async ($, on) => {
  const { w, meter } = engine(on);
  meter.usd = undefined;
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });

  expect(await turn($, w, meter, undefined)).toEqual({ text: `4s · 12.3k${B}in${B}845${B}out` });
});

for (const [glyphSet, env, line] of [
  ["Unicode", {}, `4s · 12.3k${B}in${B}845${B}out · !${B}no${B}evidence:${B}bun${B}test${B}sr…`],
  ["ASCII", { OMCA_GLYPHS: "ascii" }, `4s - 12.3k${B}in${B}845${B}out - !${B}no${B}evidence:${B}bun${B}test...`],
] as const) {
  test(`the footer is one line that keeps to one row of an 80-column terminal, in the ${glyphSet} glyph set`, async ($, on) => {
    const { w, meter } = engine(on, { [STATUS]: statusFile(LONG, STARTED_S + 2) }, env);
    await $.turn.start({ text: "Run the tests", turnId: "t-1" });
    const { text } = await turn($, w, meter, 0.2812);

    expect(text).toBe(line);
    expect(displayWidth(`● oh-my-claudeagent: ${text}`)).toBeLessThanOrEqual(72);
  });
}

const ENGINE_LINE = "engine turn line";
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);

function terminal(on: On, files: Readonly<Record<string, string>> = {}) {
  const made = engine(on, files);
  made.w.surfaces = ["terminal"];
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [ENGINE_LINE] });
  });
  return made;
}

type TurnProps = { word: string; durationMs: number; isExpanded?: boolean; waitingFor?: { agents: { id: string; agentType: string }[]; workflows: number } };

async function line($: Engine, requestId: string, props: TurnProps = { word: "Cooked", durationMs: 4_200 }) {
  const mounted = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", component: "TurnDuration", requestId, props: props as { word: string; durationMs: number } });
  const texts = (await mounted.findAll({ type: "Text" })).map((element) => element.text).filter((text) => text !== "");
  await mounted.unmount();
  return texts;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

test("on a terminal the turn's facts move into the line that closes it, and no text row follows the answer", async ($, on) => {
  const { w, meter } = terminal(on, { [STATUS]: statusFile("just test", STARTED_S + 2) });
  ledgerAt(w, STARTED_S - 600);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });
  expect(await turn($, w, meter, 0.2812)).toEqual({ text: "The tests ran." });

  const [mark, text] = await line($, "turn-1");
  expect(mark).toBe("✻");
  // 78 cells beside the mark of an 80-column row: the clock gives way to the receipt.
  expect(text).toBe("Cooked for 4s · 12.3k in 845 out · $0.0312 · ! just test not logged");
});

test("with room, the line also says when the turn was done", async ($, on) => {
  const { w, meter } = terminal(on);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });
  await turn($, w, meter, 0.2812);

  expect((await line($, "turn-1"))[1]).toBe(`Cooked for 4s · done ${clock(NOW + 4_200)} · 12.3k in 845 out · $0.0312`);
});

test("a logged verification reads logged on the line", async ($, on) => {
  const { w, meter } = terminal(on, { [STATUS]: statusFile("bun test", STARTED_S + 2) });
  ledgerAt(w, STARTED_S + 3);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });
  await turn($, w, meter, 0.2812);

  expect((await line($, "turn-1"))[1]).toEndWith("· ✓ bun test logged");
});

test("a line drawn before its turn's facts land keeps the engine's line, and takes them once they do", async ($, on) => {
  const { w, meter } = terminal(on);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });
  expect(await line($, "turn-1")).toEqual([ENGINE_LINE]);
  await turn($, w, meter, 0.2812);
  expect((await line($, "turn-1"))[1]).toStartWith("Cooked for 4s · done");
});

test("a line belongs to the turn that started last before it was first drawn: an older line drawn again keeps the engine's", async ($, on) => {
  const { w, meter } = terminal(on);
  expect(await line($, "turn-old")).toEqual([ENGINE_LINE]);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });
  expect(await line($, "turn-new")).toEqual([ENGINE_LINE]);
  await turn($, w, meter, 0.2812);

  expect(await line($, "turn-old")).toEqual([ENGINE_LINE]);
  expect((await line($, "turn-new"))[1]).toStartWith("Cooked for 4s");
});

test("a turn that ends before the previous turn's facts land still draws its own facts, each line its turn's", async ($, on) => {
  const { w, meter } = terminal(on);
  const complete = (turnId: string, output: number) =>
    $.turn.complete({ answer: "ok", durationMs: 100, isAborted: false, turnId, reason: "answer", usage: { ...USAGE, output_tokens: output } });
  await $.turn.start({ text: "Delegate", turnId: "t-1" });
  await w.clock.advance(300);
  expect(await line($, "line-1")).toEqual([ENGINE_LINE]);
  await w.clock.advance(150);
  await $.turn.start({ text: "", turnId: "t-2" });
  await w.clock.advance(50);
  expect(await line($, "line-2")).toEqual([ENGINE_LINE]);
  meter.usd = 0.3;
  await complete("t-1", 11);
  await complete("t-2", 22);

  expect((await line($, "line-1"))[1]).toContain("12.3k in 11 out");
  expect((await line($, "line-2"))[1]).toContain("12.3k in 22 out");
});

test("a line drawn before any turn started, as after /resume, keeps the engine's line", async ($, on) => {
  const { w, meter } = terminal(on);
  expect(await line($, "turn-resumed")).toEqual([ENGINE_LINE]);
  await w.clock.advance(1_000);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });
  await turn($, w, meter, 0.2812);
  expect(await line($, "turn-resumed")).toEqual([ENGINE_LINE]);
});

test("a client that names the agents a turn waits on gets them on the line, in place of the duration", async ($, on) => {
  const { w, meter } = terminal(on);
  await $.turn.start({ text: "Delegate", turnId: "t-1" });
  await turn($, w, meter, 0.2812);

  const waiting = { agents: [{ id: "a-1", agentType: "oh-my-claudeagent:executor" }, { id: "a-2", agentType: "oh-my-claudeagent:architect" }], workflows: 0 };
  expect((await line($, "turn-1", { word: "Cooked", durationMs: 4_200, isExpanded: false, waitingFor: waiting }))[1]).toBe("Waiting for executor, architect · 12.3k in 845 out · $0.0312");
  expect((await line($, "turn-1", { word: "Cooked", durationMs: 4_200, isExpanded: false }))[1]).toStartWith("Cooked for 4s · done");
});

test("a line that names no waited-on agents keeps its own words while agents run, with the facts on a row beneath", async ($, on) => {
  const { w, meter } = terminal(on);
  on("agent.spawn", () => ({ model: "claude-sonnet-5-5", agentId: "a-1" }));
  await $.agent.spawn({
    tool_use_id: "toolu_1",
    prompt: "work",
    description: "work",
    subagentType: "oh-my-claudeagent:executor",
    provider: { plugin: PLUGIN, tier: "user" },
    parentModel: "claude-opus-5-5",
    background: true,
    fork: false,
  });
  await $.turn.start({ text: "Delegate", turnId: "t-1" });
  await turn($, w, meter, 0.2812);

  const kept = [ENGINE_LINE, "12.3k in 845 out · $0.0312"];
  expect((await line($, "turn-1")).slice(0, 2)).toEqual(kept);
  expect((await line($, "turn-1", { word: "Cooked", durationMs: 4_200, isExpanded: false })).slice(0, 2)).toEqual(kept);
});

test("a line that also waits on a workflow keeps the engine's words, with the facts on a row beneath", async ($, on) => {
  const { w, meter } = terminal(on);
  await $.turn.start({ text: "Delegate", turnId: "t-1" });
  await turn($, w, meter, 0.2812);

  const waiting = { agents: [{ id: "a-1", agentType: "oh-my-claudeagent:executor" }], workflows: 1 };
  const drawn = await line($, "turn-1", { word: "Cooked", durationMs: 4_200, isExpanded: false, waitingFor: waiting });
  expect(drawn.slice(0, 2)).toEqual([ENGINE_LINE, "12.3k in 845 out · $0.0312"]);
});

test("the expanded transcript keeps the engine's line, with the facts on a row beneath", async ($, on) => {
  const { w, meter } = terminal(on);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });
  await turn($, w, meter, 0.2812);

  expect((await line($, "turn-1", { word: "Cooked", durationMs: 4_200, isExpanded: true })).slice(0, 2)).toEqual([ENGINE_LINE, "12.3k in 845 out · $0.0312"]);
});

test("a run already on one turn's line is not repeated on the next, which starts in the same second", async ($, on) => {
  const { w } = terminal(on, { [STATUS]: statusFile("just test", STARTED_S) });
  ledgerAt(w, STARTED_S - 600);
  await $.turn.start({ text: "Run the tests", turnId: "t-1" });
  expect(await line($, "line-1")).toEqual([ENGINE_LINE]);
  await $.turn.complete({ answer: "ok", durationMs: 100, isAborted: false, turnId: "t-1", reason: "answer", usage: USAGE });
  await w.clock.advance(200);
  await $.turn.start({ text: "", turnId: "t-2" });
  await w.clock.advance(100);
  expect(await line($, "line-2")).toEqual([ENGINE_LINE]);
  await $.turn.complete({ answer: "ok", durationMs: 100, isAborted: false, turnId: "t-2", reason: "answer", usage: USAGE });

  expect((await line($, "line-1"))[1]).toEndWith("! just test not logged");
  expect((await line($, "line-2"))[1]).not.toContain("just test");
});
