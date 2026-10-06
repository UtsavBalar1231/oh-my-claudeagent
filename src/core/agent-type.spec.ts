import { expect, test } from "bun:test";
import { omcaAgentName } from "./agent-type.ts";

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
