import { describe, expect, test } from "bun:test";
import type { GroupCall } from "./receipt.ts";
import { isPoorReport, NOTHING_SEEN, receiptLine, reportBody, type Seen, seeCall } from "./report-receipt.ts";
import { EVIDENCE_LOG_TOOL } from "./verification.ts";

const ROOT = "/work";
const HEAD = "[OMCA receipt] What this agent's tool calls did, as OMCA saw them, not as the agent reports: ";

const call = (tool: string, input: Record<string, unknown>, done: Partial<GroupCall> = {}): GroupCall => ({
  tool,
  input,
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { stdout: "", stderr: "" },
  ...done,
});
const edit = (path: string) => call("Edit", { file_path: path });
const passing = (command: string) => call("Bash", { command }, { output: { stdout: "12 pass\n", stderr: "" } });
const failing = (command: string, output = "Exit code 1\nFAIL src/a.spec.ts") => call("Bash", { command }, { isErrored: true, output });
const logged = call(EVIDENCE_LOG_TOOL, { evidence_type: "test" });
const replay = (...calls: GroupCall[]): Seen => calls.reduce((seen, next) => seeCall(seen, next, ROOT), NOTHING_SEEN);

describe("seeCall", () => {
  test("an edit records its path under the root once, and a failed edit records nothing", () => {
    const seen = replay(edit("/work/src/a.ts"), call("Write", { file_path: "/elsewhere/b.ts" }), edit("/work/src/a.ts"), call("Edit", { file_path: "/work/c.ts" }, { isErrored: true }));
    expect(seen.edited).toEqual(["src/a.ts", "/elsewhere/b.ts"]);
    expect(replay(call("NotebookEdit", { notebook_path: "/work/n.ipynb" })).edited).toEqual(["n.ipynb"]);
  });

  test("only a verification command becomes the check, and the newest one wins", () => {
    expect(replay(passing("ls -la")).check).toBeNull();
    expect(replay(failing("just test"), passing("bun test src")).check).toEqual({ command: "bun test src", state: "pass", exitCode: 0, summary: "12 pass" });
    expect(replay(passing("bun test src"), failing("just test")).check).toEqual({ command: "just test", state: "fail", exitCode: 1, summary: "FAIL src/a.spec.ts" });
  });

  test("evidence counts only after a check, and a newer check needs its own", () => {
    expect(replay(logged, passing("bun test src")).isLogged).toBe(false);
    expect(replay(passing("bun test src"), logged).isLogged).toBe(true);
    expect(replay(passing("bun test src"), logged, failing("just test")).isLogged).toBe(false);
    expect(replay(passing("bun test src"), call(EVIDENCE_LOG_TOOL, {}, { isErrored: true })).isLogged).toBe(false);
  });
});

describe("receiptLine", () => {
  test("an agent that edited nothing and ran no check gets no line", () => {
    expect(receiptLine(NOTHING_SEEN)).toBeNull();
    expect(receiptLine(replay(passing("ls")))).toBeNull();
  });

  test("edits without a check say so", () => {
    expect(receiptLine(replay(edit("/work/src/a.ts")))).toBe(`${HEAD}edited 1 file (src/a.ts); no test, build or lint command seen.`);
  });

  test("a failed check names its exit code and the missing evidence", () => {
    expect(receiptLine(replay(edit("/work/a.ts"), edit("/work/b.ts"), failing("just test")))).toBe(
      `${HEAD}edited 2 files (a.ts, b.ts); last check \`just test\` failed with exit code 1, with no evidence logged after it.`,
    );
  });

  test("a passing check with evidence after it, and no edits", () => {
    expect(receiptLine(replay(passing("bun test src"), logged))).toBe(`${HEAD}last check \`bun test src\` passed, with evidence logged after it.`);
  });

  test("past three files the rest are counted, and a check without an exit line or a stopped one says only that", () => {
    const five = ["a", "b", "c", "d", "e"].map((name) => edit(`/work/${name}.ts`));
    expect(receiptLine(replay(...five, failing("just test", "boom")))).toBe(
      `${HEAD}edited 5 files (a.ts, b.ts, c.ts and 2 more); last check \`just test\` failed, with no evidence logged after it.`,
    );
    expect(receiptLine(replay(call("Bash", { command: "just test" }, { isInterrupted: true })))).toBe(
      `${HEAD}last check \`just test\` was stopped, with no evidence logged after it.`,
    );
  });

  test("a check that returned while still running has no verdict, and replaces an earlier one", () => {
    const background = call("Bash", { command: "bun test src", run_in_background: true }, { isRunning: true });
    expect(receiptLine(replay(failing("just test"), background))).toBe(
      `${HEAD}last check \`bun test src\` went to the background, so OMCA saw no result, with no evidence logged after it.`,
    );
    expect(replay(call("Bash", { command: "bun run dev" }, { isRunning: true })).check).toBeNull();
  });

  test("a long command is cut at 120 characters", () => {
    const command = `bun test ${"x".repeat(200)}`;
    expect(receiptLine(replay(passing(command)))).toBe(`${HEAD}last check \`${command.slice(0, 117)}...\` passed, with no evidence logged after it.`);
  });
});

describe("isPoorReport and reportBody", () => {
  test("an empty or transitional stub is poor, and a short answer or a long report is not", () => {
    expect([isPoorReport(""), isPoorReport("Let me check the parser."), isPoorReport("4"), isPoorReport(`Let me know. ${"Detail. ".repeat(30)}`)]).toEqual([true, true, false, false]);
  });

  test("the harness note and trailing blank lines are not the report", () => {
    expect(reportBody("[harness: matched a pattern]\nsrc/a.ts:3 defines it\n\n")).toBe("src/a.ts:3 defines it");
    expect(reportBody("[1] src/a.ts\n[2] src/b.ts")).toBe("[1] src/a.ts\n[2] src/b.ts");
  });
});
