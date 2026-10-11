import { expect, test } from "bun:test";
import { lookOf, omcaAgentName } from "./agent-type.ts";

test("a fork looks like the agent it copies, any other agent like its own type", () => {
  expect(lookOf({ type: "fork", forkOf: "oh-my-claudeagent:orchestrator" })).toBe("oh-my-claudeagent:orchestrator");
  expect(lookOf({ type: "fork" })).toBe("fork");
  expect(lookOf({ type: "oh-my-claudeagent:executor" })).toBe("oh-my-claudeagent:executor");
});

test("a prefixed or bare name resolves to the bare name", () => {
  expect(omcaAgentName("oh-my-claudeagent:planner")).toBe("planner");
  expect(omcaAgentName("planner")).toBe("planner");
});

test("any other prefix, an empty name and a nested prefix resolve to nothing", () => {
  expect(omcaAgentName("other:planner")).toBeUndefined();
  expect(omcaAgentName("oh-my-claudeagent:")).toBeUndefined();
  expect(omcaAgentName("oh-my-claudeagent:a:planner")).toBeUndefined();
  expect(omcaAgentName("")).toBeUndefined();
});
