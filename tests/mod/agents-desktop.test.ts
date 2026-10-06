import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";
import { drain, pane, rows, run, usage, world } from "./world.ts";

const spawnOf = (n: number, type: string, description: string) =>
  ({
    tool_use_id: `toolu_${n}`,
    prompt: description,
    description,
    subagentType: `oh-my-claudeagent:${type}`,
    provider: { plugin: "oh-my-claudeagent", tier: "user" },
    parentModel: "claude-opus-5-5",
    background: true,
    fork: false,
  }) as const;

function engine(on: On): void {
  let spawned = 0;
  on("agent.spawn", () => ({ model: "claude-sonnet-5-5", agentId: `a-${++spawned}` }));
  on("turn.step", async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "",
      toolUses: [{ name: "Read", input: { file_path: "/work/src/parser.ts" } }],
      stopReason: "tool_use",
      usage: usage(1200, 300),
    };
  });
  on("turn.complete", (_$, e) => ({ text: e.answer }));
}

test("the Agents tab mounts on desktop with a running lane and a finished agent's block", async ($, on) => {
  const w = world(on, {});
  w.surfaces = ["desktop"];
  engine(on);
  await $.command.run(run(""));
  await $.agent.spawn(spawnOf(1, "executor", "Fix the heading parser"));
  await $.agent.spawn(spawnOf(2, "explorer", "Map the router callers"));
  await drain($.turn.step({ turnId: "t-a-1", index: 0, model: "claude-sonnet-5-5", effort: "high", messageCount: 1, agentId: "a-1" }));
  await $.turn.complete({ answer: "Mapped 14 callers.", durationMs: 1000, isAborted: false, turnId: "t-a-2", reason: "answer", agentId: "a-2", usage: usage(2000, 500) });
  w.agents = [{ id: "a-1", description: "", type: "x", status: "running" }];

  const ui = await $.ui.mount(pane("desktop"));
  const drawn = rows(await ui.drawn()).join("\n");

  expect(drawn).toContain("executor · Fix the heading parser");
  expect(drawn).toContain("Mapped 14 callers.");
  expect(drawn).toContain("1 running · 1 finished");
  await ui.unmount();
});
