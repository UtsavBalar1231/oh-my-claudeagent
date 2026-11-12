import { expect, test } from "bun:test";
import { agentsDoneText, type Member, outcomeOf } from "./notify.ts";
import { glyphs } from "./ui-kit.ts";

const g = glyphs("unicode");
const member = (type: string, outcome: Member["outcome"], description = "Map the callers"): Member => ({ type: `oh-my-claudeagent:${type}`, description, outcome });

test("a turn's reason classes as finished, stopped or failed, a refusal and an error both failing", () => {
  expect(["answer", "aborted", "error", "refusal"].map(outcomeOf)).toEqual(["finished", "stopped", "failed", "failed"]);
});

test("one agent reads its short type, its outcome and its task", () => {
  expect(agentsDoneText([member("explorer", "finished")], g)).toBe("explorer finished · Map the callers");
  expect(agentsDoneText([member("executor", "failed", "Fix\nthe   parser")], g)).toBe("executor failed · Fix the parser");
  expect(agentsDoneText([member("architect", "stopped")], g)).toBe("architect stopped · Map the callers");
});

test("one agent with no task reads without the dot", () => {
  expect(agentsDoneText([member("explorer", "finished", "")], g)).toBe("explorer finished");
});

test("several finished agents read their count and their types in spawn order", () => {
  expect(agentsDoneText([member("explorer", "finished"), member("executor", "finished"), member("explorer", "finished")], g)).toBe(
    "3 agents finished · explorer, executor, explorer",
  );
});

test("several agents with a failure lead with the counts", () => {
  const wave = [member("explorer", "finished"), member("executor", "failed"), member("architect", "finished")];
  expect(agentsDoneText(wave, g)).toBe("3 agents done, 1 failed · explorer, executor, architect");
  expect(agentsDoneText([...wave, member("reviewer", "stopped"), member("viewer", "failed")], g)).toBe(
    "5 agents done, 2 failed, 1 stopped · explorer, executor, architect, reviewer, viewer",
  );
  expect(agentsDoneText([member("explorer", "stopped"), member("executor", "finished")], g)).toBe("2 agents done, 1 stopped · explorer, executor");
});

test("a long task is cut under 200 characters with the glyph ellipsis", () => {
  const text = agentsDoneText([member("explorer", "finished", "x".repeat(400))], g);
  expect(text.length).toBeLessThan(200);
  expect(text.endsWith("…")).toBe(true);
  expect(agentsDoneText([member("explorer", "finished", "x".repeat(400))], glyphs("ascii")).endsWith("...")).toBe(true);
});

test("a wave with no member has no text", () => {
  expect(agentsDoneText([], g)).toBe("");
});
