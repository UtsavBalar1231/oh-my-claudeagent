import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { POOR_OUTPUT } from "../../src/core/report-receipt.ts";
import { EVIDENCE_LOG_TOOL } from "../../src/core/verification.ts";
import { world } from "./world.ts";

const HEAD = "[OMCA receipt] What this agent's tool calls did, as OMCA saw them, not as the agent reports: ";
const REPORT = "Fixed the parser in src/parser.ts; the suite passes.";

type Answer = { result?: unknown; text?: string; isError?: true; deny?: string };

// Each test names its agents with its own prefix, so no module state of an earlier test is read as this one's.
function engine(on: On, env: Record<string, string> = {}): { answer: (tool_use_id: string, answer: Answer) => void } {
  world(on, {}, {}, env);
  const answers = new Map<string, Answer>();
  on("tool.call", (_$, e) => (answers.get(e.tool_use_id) ?? { result: {}, text: "" }) as never);
  on("agent.report", (_$, e) => ({ text: e.text, review: "off" }));
  return { answer: (id, answer) => answers.set(id, answer) };
}

let calls = 0;

// The engine's types drop `agentId` from a tool call's input; its loop carries it, and so does the test engine.
function call($: Engine, agentId: string | undefined, input: Record<string, unknown>): Promise<unknown> {
  return $.tool.call({ tool_use_id: `toolu_${++calls}`, ...input, ...(agentId === undefined ? {} : { agentId }) } as never);
}

const report = ($: Engine, agentId: string, text: string, fields: { status?: "completed" | "failed" | "stopped"; subagentType?: string } = {}) =>
  $.agent.report({ agentId, subagentType: fields.subagentType ?? "oh-my-claudeagent:executor", provider: { plugin: "oh-my-claudeagent", tier: "user" }, status: fields.status ?? "completed", text });

test("a report gets a receipt of the files the agent edited, its failed check and the evidence it did not log", async ($, on) => {
  const { answer } = engine(on);
  await call($, "rr1", { tool: "Edit", file_path: "/work/src/parser.ts", old_string: "a", new_string: "b" });
  await call($, "rr1", { tool: "Write", file_path: "/work/src/parser.spec.ts", content: "x" });
  const failure = "Exit code 1\nFAIL src/parser.spec.ts > parses a heading";
  answer(`toolu_${calls + 1}`, { result: failure, isError: true, text: failure });
  await call($, "rr1", { tool: "Bash", command: "bun test src/parser.spec.ts" });

  expect(await report($, "rr1", REPORT)).toEqual({
    text: `${REPORT}\n\n${HEAD}edited 2 files (src/parser.ts, src/parser.spec.ts); last check \`bun test src/parser.spec.ts\` failed with exit code 1, with no evidence logged after it.`,
    review: "off",
  });
});

test("a passing check with evidence logged after it says both", async ($, on) => {
  const { answer } = engine(on);
  answer(`toolu_${calls + 1}`, { result: { stdout: "12 pass\n", stderr: "", interrupted: false }, text: "12 pass" });
  await call($, "rr2", { tool: "Bash", command: "just test" });
  await call($, "rr2", { tool: EVIDENCE_LOG_TOOL, evidence_type: "test", command: "just test", exit_code: 0, output_snippet: "12 pass" });

  const { text } = (await report($, "rr2", REPORT)) as { text: string };
  expect(text).toBe(`${REPORT}\n\n${HEAD}last check \`just test\` passed, with evidence logged after it.`);
});

test("a check moved to the background is never read as passed", async ($, on) => {
  const { answer } = engine(on);
  answer(`toolu_${calls + 1}`, { result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b1" }, text: "Command running in background with ID: b1" });
  await call($, "rr11", { tool: "Bash", command: "just test", run_in_background: true });

  const { text } = (await report($, "rr11", REPORT)) as { text: string };
  expect(text).toBe(`${REPORT}\n\n${HEAD}last check \`just test\` went to the background, so OMCA saw no result, with no evidence logged after it.`);
});

test("a read-only agent's report, the main loop's calls and a refused call add nothing", async ($, on) => {
  const { answer } = engine(on);
  await call($, "rr3", { tool: "Read", file_path: "/work/src/parser.ts" });
  await call($, undefined, { tool: "Edit", file_path: "/work/src/main.ts", old_string: "a", new_string: "b" });
  answer(`toolu_${calls + 1}`, { deny: "refused by a rule" });
  await call($, "rr3", { tool: "Edit", file_path: "/work/src/refused.ts", old_string: "a", new_string: "b" });

  expect(await report($, "rr3", REPORT)).toEqual({ text: REPORT, review: "off" });
});

test("an empty or stalled completed report gets the poor-output advice, a failed one and web-fetch's do not", async ($, on) => {
  engine(on);
  expect(await report($, "rr4", "")).toEqual({ text: POOR_OUTPUT, review: "off" });
  expect(await report($, "rr5", "Let me check the parser first.")).toEqual({ text: `Let me check the parser first.\n\n${POOR_OUTPUT}`, review: "off" });
  expect(await report($, "rr6", "", { status: "failed" })).toEqual({ text: "", review: "off" });
  expect(await report($, "rr7", "", { subagentType: "web-fetch" })).toEqual({ text: "", review: "off" });
});

test("OMCA_DISABLED_HOOKS turns off the receipt and the poor-output advice by their own names", async ($, on) => {
  engine(on, { OMCA_DISABLED_HOOKS: "report-receipts" });
  await call($, "rr8", { tool: "Edit", file_path: "/work/src/parser.ts", old_string: "a", new_string: "b" });
  expect(await report($, "rr8", REPORT)).toEqual({ text: REPORT, review: "off" });
  expect(await report($, "rr9", "")).toEqual({ text: POOR_OUTPUT, review: "off" });
});

test("OMCA_DISABLED_HOOKS=empty-task-response keeps the receipt and drops the advice", async ($, on) => {
  engine(on, { OMCA_DISABLED_HOOKS: "empty-task-response" });
  await call($, "rr10", { tool: "Edit", file_path: "/work/src/parser.ts", old_string: "a", new_string: "b" });
  expect(await report($, "rr10", "")).toEqual({ text: `${HEAD}edited 1 file (src/parser.ts); no test, build or lint command seen.`, review: "off" });
});
