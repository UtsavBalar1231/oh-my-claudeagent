import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POOR_HANDBACK, POOR_OUTPUT } from "./empty-task-response.ts";
import { dispatch, type Payload } from "./registry.ts";

const NOW = 1_786_000_000_000;
const FULL_EXECUTOR_REPORT =
  "TASK: fix the bug\nSTATUS: complete\nCHANGES: scripts/foo.sh, fixed field read\nEVIDENCE: just test-hooks passed, 21 tests\nNOTES: no blockers";
const UNSTRUCTURED = "I completed the task and made the changes. The implementation is done and working correctly as expected.";
const POOR = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: POOR_OUTPUT } };
const OWN = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: POOR_HANDBACK } };
const advisory = (agent: string, missing: string) => ({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: `[ADVISORY] Agent '${agent}' output is missing expected section headers: ${missing}. The required output format specifies these sections. Output may be incomplete or hard to parse downstream.`,
  },
});

const roots: string[] = [];

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function check(fields: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "omca-task-response-"));
  roots.push(root);
  return dispatch({ event: "PostToolUse", session_id: crypto.randomUUID(), ...fields }, root, NOW);
}

const handback = (message: string, agentType = "oh-my-claudeagent:executor") =>
  check({ tool_name: "SubagentHandback", agent_id: "a1", agent_type: agentType, tool_input: { message } });

const agentResult = (toolResponse: unknown, subagentType = "oh-my-claudeagent:executor") =>
  check({ tool_name: "Agent", tool_input: { subagent_type: subagentType }, tool_response: toolResponse });

describe("payloads that carry no report", () => {
  test("empty-task-response: async launch acknowledgement is silent", async () => {
    expect(await agentResult({ isAsync: true, status: "async_launched", agentId: "a1", outputFile: "/tmp/a1.txt" })).toEqual({});
  });

  test("empty-task-response: completed Agent result pointing at a hand-back is silent", async () => {
    const pointer = `This agent's report was delivered to you as a message from "a1" (its SubagentHandback call). Read it there; it is not repeated here.`;
    expect(await agentResult({ status: "completed", handback: "send", content: [{ type: "text", text: pointer }] })).toEqual({});
  });

  test("empty-task-response: a tool other than Agent or SubagentHandback is never checked", async () => {
    expect(await check({ tool_name: "Read", tool_input: { message: "4" }, tool_response: { status: "completed", content: [] } })).toEqual({});
  });
});

describe("SubagentHandback carries the report", () => {
  test("empty-task-response: a short hand-back tells the subagent itself to hand back a complete report", async () => {
    expect(await handback("4")).toEqual(OWN);
    expect(POOR_HANDBACK).toBe("Your hand-back is empty or misses required sections; hand back a complete report.");
  });

  test("empty-task-response: the orchestrator-addressed advice never reaches a subagent's own hand-back", async () => {
    for (const message of ["4", UNSTRUCTURED]) {
      const text = JSON.stringify(await handback(message));
      expect(text).not.toContain("SendMessage");
      expect(text).not.toContain("cannot be resumed");
    }
  });

  test("empty-task-response: a transitional-only hand-back gets the hand-back advice", async () => {
    expect(await handback("Now let me start working on this task for you.")).toEqual(OWN);
  });

  test("empty-task-response: a short report whose later line starts like a transition is not poor", async () => {
    const report = "FILES: a.ts\nANSWER: the guard lives in a.ts\nNEXT STEPS: read b.ts";
    expect(await handback(report, "oh-my-claudeagent:explorer")).toEqual({});
    expect(await handback(`Next, ${report}`, "oh-my-claudeagent:explorer")).toEqual(OWN);
  });

  test("empty-task-response: a transitional phrase inside a long report is not poor", async () => {
    const report = `${FULL_EXECUTOR_REPORT}\nLet me know if the field name should change. ${"Detail. ".repeat(20)}`;
    expect(await handback(report)).toEqual({});
  });

  test("empty-task-response: a terse completion acknowledgement is not treated as poor", async () => {
    expect(await handback("Done. Ending.", "oh-my-claudeagent:custom")).toEqual({});
    expect(await handback("Nothing further to report.", "oh-my-claudeagent:custom")).toEqual({});
  });

  test("empty-task-response: a terse completion from a structured agent still gets the hand-back advice", async () => {
    expect(await handback("Done. Ending.")).toEqual(OWN);
  });

  test("empty-task-response: full hand-back report is silent", async () => {
    expect(await handback(FULL_EXECUTOR_REPORT)).toEqual({});
  });

  test("empty-task-response: a hand-back missing sections gets the hand-back advice", async () => {
    expect(await handback(UNSTRUCTURED)).toEqual(OWN);
  });

  test("empty-task-response: section headers match case-insensitively", async () => {
    expect(await handback(`status: done\nChanges: none\nevidence: ok\n${"Detail. ".repeat(8)}`)).toEqual({});
    expect(await handback(`status: done\nChanges: none\n${"Detail. ".repeat(8)}`)).toEqual(OWN);
  });

  test("empty-task-response: architect hand-back with its own sections is silent", async () => {
    expect(await handback("RECOMMENDATION: use strategy A\nALTERNATIVES: strategy B, C\nRISKS: low overhead", "oh-my-claudeagent:architect")).toEqual({});
  });

  test("empty-task-response: explorer needs NEXT STEPS: as one header, not NEXT and STEPS: apart", async () => {
    const report = `FILES: a.ts\nANSWER: the guard lives in a.ts\nSTEPS: none, NEXT: read b.ts ${"Detail. ".repeat(20)}`;
    expect(await handback(report, "oh-my-claudeagent:explorer")).toEqual(OWN);
  });

  test("empty-task-response: researcher sections are checked and an unknown agent type has none", async () => {
    expect(await handback(UNSTRUCTURED, "oh-my-claudeagent:researcher")).toEqual(OWN);
    expect(await handback(UNSTRUCTURED, "general-purpose")).toEqual({});
  });
});

describe("prepended harness note", () => {
  test("empty-task-response: a bracketed harness note is not measured as the report", async () => {
    expect(await handback(`[harness: subagent output matched instruction-shaped pattern(s): foo]\n${FULL_EXECUTOR_REPORT}`)).toEqual({});
  });

  test("empty-task-response: a bracketed harness note alone counts as no report", async () => {
    expect(await handback("[harness: subagent output matched instruction-shaped pattern(s): foo]")).toEqual(OWN);
  });
});

describe("a report whose lines start with a bracket", () => {
  test("empty-task-response: numbered findings are the report, not a harness note", async () => {
    expect(await handback("[1] parser lives in src/a.ts\n[2] guard lives in src/b.ts", "general-purpose")).toEqual({});
  });

  test("empty-task-response: a bracketed first line is one harness note whatever the later lines hold", async () => {
    const report = "[FILES: src/a.ts, src/b.ts]\nANSWER: the guard lives in src/b.ts and the parser in src/a.ts\nNEXT STEPS: none";
    expect(await handback(report, "oh-my-claudeagent:explorer")).toEqual(OWN);
  });
});

describe("a completed Agent result carries the report in content[].text", () => {
  test("empty-task-response: completed Agent result without hand-back gives the orchestrator the section advisory", async () => {
    expect(await agentResult({ status: "completed", content: [{ type: "text", text: UNSTRUCTURED }] })).toEqual(advisory("executor", "STATUS: CHANGES: EVIDENCE:"));
  });

  test("empty-task-response: completed Agent result with a full report is silent", async () => {
    expect(await agentResult({ status: "completed", content: [{ type: "text", text: FULL_EXECUTOR_REPORT }] })).toEqual({});
  });

  test("empty-task-response: completed Agent result with empty content gives the orchestrator the poor-output advice", async () => {
    expect(POOR_OUTPUT).toContain("delegation error carrying the agent's partial work");
    expect(await agentResult({ status: "completed", content: [] })).toEqual(POOR);
  });

  test("empty-task-response: text blocks are joined and blocks without text are skipped", async () => {
    const [head = "", tail = ""] = FULL_EXECUTOR_REPORT.split("\nEVIDENCE:");
    const content = [{ type: "text", text: head }, { type: "image" }, { type: "text", text: `EVIDENCE:${tail}` }];
    expect(await agentResult({ status: "completed", content })).toEqual({});
  });
});

describe("a hand-back payload with no agent id", () => {
  test("empty-task-response: warns with the poor-output advice when the output is empty", async () => {
    expect(await check({ tool_name: "SubagentHandback", agent_type: "explorer", tool_input: { message: "" } })).toEqual(POOR);
  });

  test("empty-task-response: warns with the poor-output advice when the output is very short", async () => {
    expect(await check({ tool_name: "SubagentHandback", agent_type: "explorer", tool_input: { message: "ok" } })).toEqual(POOR);
  });
});

describe("kill switch and a full hand-back payload", () => {
  test("empty-task-response: OMCA_DISABLED_HOOKS=empty-task-response silences both warnings", async () => {
    process.env.OMCA_DISABLED_HOOKS = "empty-task-response";
    expect([await handback("4"), await handback(UNSTRUCTURED)]).toEqual([{}, {}]);
    process.env.OMCA_DISABLED_HOOKS = "context-injector";
    expect(await handback("4")).toEqual(OWN);
  });

  const fixture = (message: string): Payload => ({
    event: "PostToolUse",
    hook_event_name: "PostToolUse",
    tool_name: "SubagentHandback",
    agent_id: "fixture-agent-001",
    agent_type: "oh-my-claudeagent:executor",
    tool_input: { message },
    tool_response: { success: true, message: "Report delivered to your caller." },
    session_id: "fixture-sid-001",
  });

  test("a poor hand-back in a full payload gets the hand-back advice", async () => {
    const root = mkdtempSync(join(tmpdir(), "omca-task-response-"));
    roots.push(root);
    expect(await dispatch(fixture("Let me check that."), root, NOW)).toEqual(OWN);
  });

  test("a complete hand-back in a full payload gets an empty answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "omca-task-response-"));
    roots.push(root);
    const report = "TASK: Implement feature X\nSTATUS: complete\nCHANGES: Modified src/main.py to add feature\nEVIDENCE: just test passed with 15 tests\nNOTES: None";
    expect(await dispatch(fixture(report), root, NOW)).toEqual({});
  });
});
