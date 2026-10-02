import type { Args, On } from "claude-code";
import { expect, test, type Engine } from "claude-code/testing";

type Spawn = Args<"agent.spawn">;
type Step = Args<"turn.step">;

const TASK = "Read README.md.\nReport the title.";

function spawnOf(toolUseId: string, prompt: string): Spawn {
  return {
    tool_use_id: toolUseId,
    prompt,
    description: "read",
    subagentType: "oh-my-claudeagent:executor",
    provider: { plugin: "oh-my-claudeagent", tier: "user" },
    parentModel: "claude-opus-5-5",
    background: true,
    fork: false,
  };
}

function stepOf(agentId: string | undefined, effort: Step["effort"]): Step {
  return {
    turnId: "t-1",
    index: 0,
    model: "claude-opus-5-5",
    messageCount: 1,
    ...(agentId !== undefined && { agentId }),
    ...(effort !== undefined && { effort }),
  };
}

function engine(on: On, deny?: string): { spawned: Spawn[]; stepped: Step[]; logged: string[] } {
  const spawned: Spawn[] = [];
  const stepped: Step[] = [];
  const logged: string[] = [];
  on("ui.log", (_$, e) => {
    if (e.text.startsWith("route:")) logged.push(e.text);
    return { value: undefined };
  });
  on("agent.spawn", (_$, e) => {
    spawned.push(e);
    return deny === undefined ? { model: e.model ?? "claude-opus-5-5", agentId: `agent-${e.tool_use_id}` } : { deny };
  });
  on("turn.step", async function* (_$, e) {
    stepped.push(e);
    return { turnId: e.turnId, index: e.index, answer: "ok", toolUses: [], stopReason: "end_turn", usage: null };
  });
  return { spawned, stepped, logged };
}

async function step($: Engine, e: Step): Promise<void> {
  const stream = $.turn.step(e);
  while ((await stream.next()).done !== true);
}

test("two concurrent spawns with different hints are routed independently by their agentId", async ($, on) => {
  const { spawned, stepped } = engine(on);

  const results = await Promise.all([
    $.agent.spawn(spawnOf("a", `[omca-route effort=low]\n${TASK}`)),
    $.agent.spawn(spawnOf("b", `[omca-route effort=xhigh]\n${TASK}`)),
  ]);
  await step($, stepOf("agent-a", "medium"));
  await step($, stepOf("agent-b", "medium"));
  await step($, stepOf("agent-a", "high"));

  expect(results).toEqual([
    { model: "claude-opus-5-5", agentId: "agent-a" },
    { model: "claude-opus-5-5", agentId: "agent-b" },
  ]);
  expect(spawned).toEqual([spawnOf("a", TASK), spawnOf("b", TASK)]);
  expect(stepped.map((e) => [e.agentId, e.effort])).toEqual([
    ["agent-a", "low"],
    ["agent-b", "xhigh"],
    ["agent-a", "low"],
  ]);
});

test("a main-loop step keeps its effort while a routed subagent exists", async ($, on) => {
  const { stepped } = engine(on);

  await $.agent.spawn(spawnOf("a", `[omca-route effort=low]\n${TASK}`));
  await step($, stepOf(undefined, "high"));

  expect(stepped).toEqual([stepOf(undefined, "high")]);
});

test("a routed subagent's step without an effort is left untouched", async ($, on) => {
  const { stepped } = engine(on);

  await $.agent.spawn(spawnOf("a", `[omca-route effort=low]\n${TASK}`));
  await step($, stepOf("agent-a", undefined));

  expect(stepped).toEqual([stepOf("agent-a", undefined)]);
  expect("effort" in (stepped[0] ?? {})).toBe(false);
});

test("a model field is ignored and logged, the spawn's model is untouched, and the effort still routes", async ($, on) => {
  const { spawned, stepped, logged } = engine(on);
  const sonnet = { ...spawnOf("b", `[omca-route effort=low model=opus]\n${TASK}`), model: "sonnet" };

  expect(await $.agent.spawn(spawnOf("a", `[omca-route model=opus]\n${TASK}`))).toEqual({
    model: "claude-opus-5-5",
    agentId: "agent-a",
  });
  await $.agent.spawn(sonnet);
  await step($, stepOf("agent-a", "medium"));
  await step($, stepOf("agent-b", "medium"));

  expect(spawned).toEqual([spawnOf("a", TASK), { ...spawnOf("b", TASK), model: "sonnet" }]);
  expect("model" in (spawned[0] ?? {})).toBe(false);
  expect(stepped).toEqual([stepOf("agent-a", "medium"), stepOf("agent-b", "low")]);
  expect(logged).toEqual([
    "route: ignored unknown hint field model=opus",
    "route: ignored unknown hint field model=opus",
  ]);
});

test("without a hint, or with a malformed one, the spawn and its steps pass through unchanged", async ($, on) => {
  const { spawned, stepped } = engine(on);
  const malformed = `[omca-route effort=low\n${TASK}`;

  await $.agent.spawn(spawnOf("a", TASK));
  await $.agent.spawn(spawnOf("b", malformed));
  await step($, stepOf("agent-a", "medium"));
  await step($, stepOf("agent-b", "medium"));

  expect(spawned).toEqual([spawnOf("a", TASK), spawnOf("b", malformed)]);
  expect(stepped).toEqual([stepOf("agent-a", "medium"), stepOf("agent-b", "medium")]);
});

test("unknown hint values are stripped, logged to debug, and route nothing", async ($, on) => {
  const { spawned, stepped, logged } = engine(on);

  await $.agent.spawn(spawnOf("a", `[omca-route effort=extreme temperature=0]\n${TASK}`));
  await step($, stepOf("agent-a", "medium"));

  expect(spawned).toEqual([spawnOf("a", TASK)]);
  expect(stepped).toEqual([stepOf("agent-a", "medium")]);
  expect(logged).toEqual([
    "route: ignored unknown hint field effort=extreme",
    "route: ignored unknown hint field temperature=0",
  ]);
});

test("a denied spawn records no route", async ($, on) => {
  const { stepped } = engine(on, "not now");

  expect(await $.agent.spawn(spawnOf("a", `[omca-route effort=low]\n${TASK}`))).toEqual({ deny: "not now" });
  await step($, stepOf("agent-a", "medium"));

  expect(stepped).toEqual([stepOf("agent-a", "medium")]);
});
