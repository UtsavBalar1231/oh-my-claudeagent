import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { PLUGIN } from "./world.ts";

const SPAWN = {
  prompt: "Port module 13.",
  description: "port module 13",
  subagentType: "oh-my-claudeagent:executor",
  provider: { plugin: PLUGIN, tier: "user" },
  parentModel: "claude-opus-5-5",
  background: true,
  fork: false,
} as const;

const plan = (done: number, total: number) => ({ name: "p", path: "/p.md", done, total, next: null });

function world(on: On, bandPlan: ReturnType<typeof plan> | null): void {
  const atoms = new Map<string, { value: unknown; version: number }>([
    ["band", { value: { plan: bandPlan, verification: null, error: null, readAt: 0 }, version: 1 }],
  ]);
  on("state.get", (_$, e) => ({ value: atoms.get(e.key) ?? { value: undefined, version: 0 } }));
  on("state.set", (_$, e) => {
    const version = (atoms.get(e.key)?.version ?? 0) + 1;
    atoms.set(e.key, { value: e.value, version });
    return { value: { isSet: true, version } };
  });
  on("clock.now", () => ({ value: 1_790_000_000_000 }));
  on("session.id", () => ({ value: "s1" }));
  on("ui.log", () => ({ value: undefined }));
  on("agent.spawn", (_$, e) => ({ model: "claude-sonnet-5-5", agentId: `agent-${e.tool_use_id}` }));
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    if (e.component !== "Spinner") return Text({ children: [] });
    return Text({ children: [`${e.props.word}${e.props.suffix}`] });
  });
}

const spawn = (id: string, extra: object = {}) => ({ ...SPAWN, tool_use_id: id, ...extra });

async function drawn($: Engine, surface: "terminal" | "desktop", requestId: string): Promise<string | undefined> {
  const mounted = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: "Spinner",
    requestId,
    props: { word: "Sauteing", message: null, suffix: "…", mode: "thinking" },
  });
  const text = (await mounted.findAll({ type: "Text" })).map((element) => element.text)[0];
  await mounted.unmount();
  return text;
}

test("the main spinner's suffix names the next task and the running agents", async ($, on) => {
  world(on, plan(6, 14));
  await $.agent.spawn(spawn("1"));
  await $.agent.spawn(spawn("2"));
  await $.agent.spawn(spawn("3"));
  await $.agent.spawn(spawn("4", { isTeammate: true }));

  expect(await drawn($, "terminal", "main")).toBe("Sauteing… · task 7/14 · 3 agents");
});

test("the suffix drops the parts that do not apply", async ($, on) => {
  world(on, null);
  expect(await drawn($, "terminal", "main")).toBe("Sauteing…");
  await $.agent.spawn(spawn("1"));
  await $.agent.spawn(spawn("2"));
  expect(await drawn($, "terminal", "main")).toBe("Sauteing… · 2 agents");
});

test("with a plan and no agents the suffix names only the task", async ($, on) => {
  world(on, plan(6, 14));
  expect(await drawn($, "terminal", "main")).toBe("Sauteing… · task 7/14");
});

test("a subagent's spinner and every desktop spinner pass through unchanged", async ($, on) => {
  world(on, plan(6, 14));
  await $.agent.spawn(spawn("1"));

  expect(await drawn($, "terminal", "agent-1")).toBe("Sauteing…");
  expect(await drawn($, "desktop", "main")).toBe("Sauteing…");
});
