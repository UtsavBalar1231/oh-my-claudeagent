import { expect, test } from "claude-code/testing";
import { dispatch, dispatchStream, featuresFor, type Feature, type Features } from "../../hooks/dispatch.ts";

type Logs = { log: (text: string) => void; lines: string[] };
type Spawn = { prompt: string; model?: string };
type Spawned = { model: string; agentId?: string } | { deny: string };
type Answer = { text?: string; block?: string; deny?: string; decision?: "allow" | "ask" | "deny"; reason?: string };

function logs(): Logs {
  const lines: string[] = [];
  return { lines, log: (text) => void lines.push(text) };
}

function counted<E, R>(answer: (e: E) => R): { calls: E[]; next: (e: E) => Promise<R> } {
  const calls: E[] = [];
  return { calls, next: async (e) => (calls.push(e), answer(e)) };
}

test("a pre rewrite reaches the next pre and next, and next runs exactly once", async () => {
  const seen: Spawn[] = [];
  const features: [string, Feature<Spawn, Spawned, Spawned, Logs>][] = [
    ["route", { pre: (_host, e) => ({ event: { ...e, model: "opus", prompt: e.prompt.replace("[hint]\n", "") } }) }],
    ["tracker", { pre: (_host, e) => void seen.push(e) }],
  ];
  const { calls, next } = counted<Spawn, Spawned>((e) => ({ model: e.model ?? "inherit", agentId: "a-1" }));

  const result = await dispatch(logs(), "agent.spawn", features, { prompt: "[hint]\nRead it." }, next);

  expect(seen).toEqual([{ prompt: "Read it.", model: "opus" }]);
  expect(calls).toEqual([{ prompt: "Read it.", model: "opus" }]);
  expect(result).toEqual({ model: "opus", agentId: "a-1" });
});

test("every post runs in order with next's result, the agentId from agent.spawn included", async () => {
  const order: string[] = [];
  const results: Spawned[] = [];
  const post = (name: string): Feature<Spawn, Spawned, Spawned, Logs> => ({
    post: (_host, _e, result) => void (order.push(name), results.push(result)),
  });
  const { calls, next } = counted<Spawn, Spawned>(() => ({ model: "claude-opus-5-5", agentId: "a-7" }));

  const result = await dispatch(logs(), "agent.spawn", [["route", post("route")], ["tracker", post("tracker")], ["ledger", post("ledger")]], { prompt: "go" }, next);

  expect(calls.length).toBe(1);
  expect(order).toEqual(["route", "tracker", "ledger"]);
  expect(results).toEqual([
    { model: "claude-opus-5-5", agentId: "a-7" },
    { model: "claude-opus-5-5", agentId: "a-7" },
    { model: "claude-opus-5-5", agentId: "a-7" },
  ]);
  expect(result).toEqual({ model: "claude-opus-5-5", agentId: "a-7" });
});

test("a pre answer skips next, yet every pre still runs", async () => {
  const ran: string[] = [];
  const features: [string, Feature<Spawn, Spawned, Spawned, Logs>][] = [
    ["guard", { pre: () => (ran.push("guard"), { answer: { deny: "not this agent" } }) }],
    ["route", { pre: () => void ran.push("route"), post: () => void ran.push("route post") }],
  ];
  const { calls, next } = counted<Spawn, Spawned>(() => ({ model: "x" }));

  expect(await dispatch(logs(), "agent.spawn", features, { prompt: "go" }, next)).toEqual({ deny: "not this agent" });
  expect(calls).toEqual([]);
  expect(ran).toEqual(["guard", "route"]);
});

const FIRST_WINS: readonly (readonly [string, readonly Answer[], Answer])[] = [
  ["a text before a deny", [{ text: "t" }, { block: "b" }, { deny: "d" }], { text: "t" }],
  ["the first deny of two", [{ deny: "first" }, { deny: "second" }], { deny: "first" }],
  ["an ask decision before a deny decision", [{ decision: "ask" }, { decision: "deny", reason: "r" }], { decision: "ask" }],
];

for (const [title, answers, expected] of FIRST_WINS) {
  test(`the first post answer in feature order wins: ${title}`, async () => {
    const features = answers.map((answer, index): [string, Feature<string, Answer, Answer, Logs>] => [
      `f${index}`,
      { post: () => ({ ...answer }) },
    ]);
    const { next } = counted<string, Answer>(() => ({ text: "from next" }));

    expect(await dispatch(logs(), "turn.complete", features, "e", next)).toEqual(expected);
  });
}

test("the first pre answer wins, and next never runs", async () => {
  const features: [string, Feature<string, Answer, Answer, Logs>][] = [
    ["a", { pre: () => ({ answer: { text: "t" } }) }],
    ["b", { pre: () => ({ answer: { deny: "d" } }) }],
  ];
  const { calls, next } = counted<string, Answer>(() => ({ text: "from next" }));

  expect(await dispatch(logs(), "x", features, "e", next)).toEqual({ text: "t" });
  expect(calls).toEqual([]);
});

test("with no answer the dispatcher returns next's result", async () => {
  const features: [string, Feature<string, Answer, Answer, Logs>][] = [["a", { pre: () => undefined, post: () => undefined }]];
  const { next } = counted<string, Answer>(() => ({ text: "from next" }));

  expect(await dispatch(logs(), "x", features, "e", next)).toEqual({ text: "from next" });
});

test("a throwing feature is isolated and logged, and the others still run", async () => {
  const host = logs();
  const ran: string[] = [];
  const features: [string, Feature<Spawn, Spawned, Spawned, Logs>][] = [
    ["route", { pre: () => { throw new Error("hint parse exploded"); } }],
    ["tracker", { pre: (_host, e) => ({ event: { ...e, model: "sonnet" } }), post: () => { throw new Error("atom write refused"); } }],
    ["ledger", { post: () => void ran.push("ledger") }],
  ];
  const { calls, next } = counted<Spawn, Spawned>((e) => ({ model: e.model ?? "" }));

  const result = await dispatch(host, "agent.spawn", features, { prompt: "go" }, next);

  expect(result).toEqual({ model: "sonnet" });
  expect(calls).toEqual([{ prompt: "go", model: "sonnet" }]);
  expect(ran).toEqual(["ledger"]);
  expect(host.lines).toEqual([
    "route pre agent.spawn failed: hint parse exploded",
    "tracker post agent.spawn failed: atom write refused",
  ]);
});

test("given a failure answer, a throwing pre fails closed without calling next", async () => {
  const host = logs();
  const deny = (reason: string): Answer => ({ decision: "deny", reason: `guard failed: ${reason}` });
  const features: [string, Feature<string, Answer, Answer, Logs>][] = [["bashGuard", { pre: () => { throw new Error("boom"); } }]];
  const { calls, next } = counted<string, Answer>(() => ({ decision: "allow" }));

  expect(await dispatch(host, "tool.check", features, "rm -rf build", next, deny)).toEqual({
    decision: "deny",
    reason: "guard failed: boom",
  });
  expect(calls).toEqual([]);
  expect(host.lines).toEqual(["bashGuard pre tool.check failed: boom"]);
});

test("given a failure answer, a throwing post replaces next's verdict with the deny", async () => {
  const deny = (reason: string): Answer => ({ decision: "deny", reason });
  const features: [string, Feature<string, Answer, Answer, Logs>][] = [["bashGuard", { post: () => { throw new Error("late"); } }]];
  const { calls, next } = counted<string, Answer>(() => ({ decision: "ask" }));

  expect(await dispatch(logs(), "tool.check", features, "git push -f", next, deny)).toEqual({ decision: "deny", reason: "late" });
  expect(calls.length).toBe(1);
});

type Step = { turnId: string; effort?: string; agentId?: string };
type Done = { answer: string };

test("the stream dispatcher rewrites before next, passes every chunk through, then runs the posts", async () => {
  const host = logs();
  const results: Done[] = [];
  const features: [string, Feature<Step, Done, never, Logs>][] = [
    ["route", { pre: (_host, e) => (e.agentId === "a-1" && e.effort !== undefined ? { event: { ...e, effort: "low" } } : undefined) }],
    ["ledger", { post: () => { throw new Error("ledger write refused"); } }],
    ["tracker", { post: (_host, _e, result) => void results.push(result) }],
  ];
  const sent: Step[] = [];
  async function* next(e: Step): AsyncGenerator<string, Done> {
    sent.push(e);
    yield "one";
    yield "two";
    return { answer: "done" };
  }

  const stream = dispatchStream(host, "turn.step", features, { turnId: "t", effort: "high", agentId: "a-1" }, next);
  const chunks: string[] = [];
  let step = await stream.next();
  while (step.done !== true) {
    chunks.push(step.value);
    step = await stream.next();
  }

  expect(sent).toEqual([{ turnId: "t", effort: "low", agentId: "a-1" }]);
  expect(chunks).toEqual(["one", "two"]);
  expect(step.value).toEqual({ answer: "done" });
  expect(results).toEqual([{ answer: "done" }]);
  expect(host.lines).toEqual(["ledger post turn.step failed: ledger write refused"]);
});

test("featuresFor takes the site's features in module order and skips modules without one", async () => {
  const pre = () => undefined;
  const band: Features = { "turn.complete": { pre } };
  const pane: Features = { "ui.render Pane": { pre } };
  const footer: Features = { "turn.complete": { pre } };

  expect(featuresFor("turn.complete", { band, pane, footer }).map(([name]) => name)).toEqual(["band", "footer"]);
  expect(featuresFor("ui.render Pane", { band, pane, footer }).map(([name]) => name)).toEqual(["pane"]);
  expect(featuresFor("session.compact", { band, pane, footer })).toEqual([]);
});
