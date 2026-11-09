import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EVIDENCE_LOG_TOOL } from "../../src/core/verification.ts";
import { dispatch, type Output } from "./registry.ts";
import { ledgerPath } from "./status-file.ts";

const NOW = 1_786_000_000_000;
const NOW_S = NOW / 1000;
const SECOND = 1000;
const LEDGER = JSON.stringify({
  entries: [{ type: "test", command: "just test", exit_code: 0, output_snippet: "10 passed", timestamp: "2026-10-02T12:05:00Z" }],
});
const BLOCK: Output = {
  decision: "block",
  reason:
    "You ran `just test` at 07:06 but logged no evidence after it. Log the real result with evidence_log, including a " +
    'non-zero exit_code if it failed. Example: evidence_log(evidence_type="test", command="just test", exit_code=0, ' +
    'output_snippet="10 passed")',
};
const INVALID_BLOCK: Output = {
  decision: "block",
  reason:
    "Verification evidence has invalid schema. Use the evidence_log MCP tool (NOT manual file writes). Required: " +
    "entries[] with type, command, exit_code, output_snippet, timestamp fields.",
};

const roots: string[] = [];
const zone = process.env.TZ;
const configDir = process.env.CLAUDE_CONFIG_DIR;
let config: string;

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "omca-task-completed-config-"));
  roots.push(config);
  process.env.CLAUDE_CONFIG_DIR = config;
});

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-task-completed-"));
  roots.push(root);
  return root;
}

const SUBAGENT = "a54ee4c474f89151b";

const record = (root: string, sessionId: string, now = NOW, agentId = "") =>
  dispatch({ event: "PostToolUse", session_id: sessionId, agent_id: agentId, tool_name: "Bash", tool_input: { command: "just test" } }, root, now);

const recordFailure = (root: string, sessionId: string, now = NOW) =>
  dispatch(
    { event: "PostToolUseFailure", session_id: sessionId, agent_id: "", tool_name: "Bash", tool_input: { command: "just test" }, error: "Exit code 1\n1 failed" },
    root,
    now,
  );

const logEvidence = (root: string, sessionId: string, now = NOW, agentId = "") =>
  dispatch(
    {
      event: "PostToolUse",
      session_id: sessionId,
      agent_id: agentId,
      tool_name: EVIDENCE_LOG_TOOL,
      tool_input: { evidence_type: "test", command: "just test", exit_code: 0, output_snippet: "10 passed" },
      tool_response: [{ type: "text", text: "Evidence recorded: test (exit 0), 1 total entries" }],
    },
    root,
    now,
  );

const complete = (root: string, sessionId: string, now = NOW, task: Record<string, unknown> = { task_description: "anything" }) =>
  dispatch({ event: "TaskCompleted", session_id: sessionId, agent_id: "", ...task }, root, now);

function writeLedger(path: string, content: string, mtimeSeconds: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeSeconds, mtimeSeconds);
}

describe("nothing recorded allows, whatever the task is named", () => {
  test("no slot, informational task: allows", async () => {
    expect(await complete(project(), crypto.randomUUID(), NOW, { task_description: "status report only" })).toEqual({});
  });

  test("no slot, verification-sounding task: allows", async () => {
    const task = { task_description: "all tests pass — implement and verify the build" };
    expect(await complete(project(), crypto.randomUUID(), NOW, task)).toEqual({});
  });

  test("false positive: 'Write documentation explaining how to fix build errors' completes", async () => {
    const task = { task_description: "Write documentation explaining how to fix build errors" };
    expect(await complete(project(), crypto.randomUUID(), NOW, task)).toEqual({});
  });

  test("false positive: 'Summarize the test strategy discussion' completes", async () => {
    const task = { task_description: "Summarize the test strategy discussion" };
    expect(await complete(project(), crypto.randomUUID(), NOW, task)).toEqual({});
  });

  test("slot ordering: no slot at all allows regardless of evidence", async () => {
    const root = project();
    writeLedger(ledgerPath(root), LEDGER, NOW_S - 600);
    const task = { task_description: "fix the build and verify the tests" };
    expect(await complete(root, crypto.randomUUID(), NOW, task)).toEqual({});
  });
});

describe("evidence logged after the verification allows", () => {
  test("slot with evidence logged after it: allows", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, NOW - 60 * SECOND);
    await logEvidence(root, sessionId, NOW - 30 * SECOND);
    expect(await complete(root, sessionId)).toEqual({});
  });

  test("evidence logged in the same second as the verification allows", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId);
    await logEvidence(root, sessionId);
    expect(await complete(root, sessionId)).toEqual({});
  });
});

describe("the completing agent answers for its own runs only", () => {
  test("a subagent's unlogged run does not block the main conversation's completion", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, NOW - 10 * SECOND, SUBAGENT);
    expect(await complete(root, sessionId)).toEqual({});
  });

  test("the main conversation's unlogged run blocks even after a subagent logs evidence", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, NOW - 20 * SECOND);
    await logEvidence(root, sessionId, NOW - 10 * SECOND, SUBAGENT);
    expect(await complete(root, sessionId)).toEqual(BLOCK);
  });

  test("a ledger written after the run by anything but this agent's evidence_log does not count", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, NOW - 20 * SECOND);
    writeLedger(ledgerPath(root), LEDGER, NOW_S);
    expect(await complete(root, sessionId)).toEqual(BLOCK);
  });

  test("a teammate completing a task is held to its own unlogged run", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, NOW - 10 * SECOND, SUBAGENT);
    expect(await complete(root, sessionId, NOW, { agent_id: SUBAGENT })).toEqual(BLOCK);
  });

  test("a teammate completing a task is not held to the main conversation's run", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, NOW - 10 * SECOND);
    expect(await complete(root, sessionId, NOW, { agent_id: SUBAGENT })).toEqual({});
  });
});

describe("a verification with no evidence after it blocks", () => {
  test("slot with no evidence at all: blocks and names the command", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId);
    expect(await complete(root, sessionId, NOW, { task_description: "status report only" })).toEqual(BLOCK);
  });

  test("a long heredoc is quoted by its first line, not whole", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    const command = `just test; python3 - <<'PY'\n${"x = 1\n".repeat(2000)}PY`;
    await dispatch({ event: "PostToolUse", session_id: sessionId, tool_name: "Bash", tool_input: { command } }, root, NOW);
    expect(await complete(root, sessionId)).toEqual({
      decision: "block",
      reason:
        "You ran `just test; python3 - <<'PY'…` at 07:06 but logged no evidence after it. Log the real result with " +
        'evidence_log, including a non-zero exit_code if it failed. Example: evidence_log(evidence_type="test", ' +
        "command=\"just test; python3 - <<'PY'…\", exit_code=0, output_snippet=\"10 passed\")",
    });
  });

  test("true positive: a recorded verification with no evidence after it blocks", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId);
    expect(await complete(root, sessionId, NOW + 30 * SECOND, { task_description: "anything at all" })).toEqual(BLOCK);
  });

  test("evidence logged before the run does not cover it: blocks", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, NOW - 600 * SECOND);
    await logEvidence(root, sessionId, NOW - 590 * SECOND);
    await record(root, sessionId);
    expect(await complete(root, sessionId)).toEqual(BLOCK);
  });

  test("true positive: a failing verification after logged evidence blocks", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, NOW - 120 * SECOND);
    await logEvidence(root, sessionId, NOW - 110 * SECOND);
    await recordFailure(root, sessionId);
    expect(await complete(root, sessionId)).toEqual(BLOCK);
  });

  test("a payload carrying no task fields blocks on the recorded state alone", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId);
    expect(await complete(root, sessionId, NOW, {})).toEqual(BLOCK);
  });

  test("a payload carrying no task fields allows when nothing was recorded", async () => {
    expect(await complete(project(), crypto.randomUUID(), NOW, {})).toEqual({});
  });
});

describe("session scoping and staleness", () => {
  test("session mismatch: a slot from another session allows", async () => {
    const root = project();
    await record(root, crypto.randomUUID());
    expect(await complete(root, crypto.randomUUID())).toEqual({});
  });

  test("staleness: a slot older than 3600s allows", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId);
    expect(await complete(root, sessionId, NOW + 4000 * SECOND)).toEqual({});
  });

  test("staleness: a slot just under 3600s still blocks", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId);
    expect(await complete(root, sessionId, NOW + 3500 * SECOND)).toEqual(BLOCK);
  });

  test("an unsafe session id carries no state, allows, and says so on stderr", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await complete(project(), "../escape")).toEqual({});
      expect(errors).toHaveBeenCalledWith('omca: ignoring hook session state for an unsafe session id "../escape"');
    } finally {
      errors.mockRestore();
    }
  });
});

describe("kill switch", () => {
  test("kill switch: OMCA_DISABLED_HOOKS listing this gate allows", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId);
    process.env.OMCA_DISABLED_HOOKS = "task-completed";
    expect(await complete(root, sessionId)).toEqual({});
  });

  test("kill switch: OMCA_DISABLED_HOOKS listing a different hook still blocks", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId);
    process.env.OMCA_DISABLED_HOOKS = "other-hook";
    expect(await complete(root, sessionId)).toEqual(BLOCK);
  });
});

describe("a run's final task", () => {
  const FINAL_BLOCK: Output = {
    decision: "block",
    reason:
      "Task #3 'Review the run' is the final task of run 'test-run', and no passing final verification names it. Review the run, then record the verdict: " +
      'evidence_log(evidence_type="final_verification", command="<what the review covered>", exit_code=0, output_snippet="<verdict, naming any task closed as blocked>", task_id="3"). ' +
      "If the review finds a gap, fix it and review again.",
  };

  const verdict = (list: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: "final_verification",
    command: "reviewer: the whole run",
    exit_code: 0,
    output_snippet: "COMPLETE",
    timestamp: "2026-10-02T12:00:00Z",
    task_id: "3",
    run: "test-run",
    task_list: list,
    ...fields,
  });

  function listed(listId: string = crypto.randomUUID()): { root: string; sessionId: string } {
    const dir = join(config, "tasks", listId);
    mkdirSync(dir, { recursive: true });
    const base = { description: "", blocks: [], metadata: { run: "test-run" } };
    writeFileSync(join(dir, "1.json"), JSON.stringify({ ...base, id: "1", subject: "Do the work", status: "completed", blockedBy: [] }));
    writeFileSync(join(dir, "3.json"), JSON.stringify({ ...base, id: "3", subject: "Review the run", status: "in_progress", blockedBy: ["1"], metadata: { run: "test-run", final: true } }));
    const root = project();
    mkdirSync(join(root, ".omca", "state", "mod"), { recursive: true });
    writeFileSync(join(root, ".omca", "state", "mod", `${listId}.json`), JSON.stringify({ written_at: NOW, task_list: listId }));
    return { root, sessionId: listId };
  }

  const closing = (root: string, sessionId: string, taskId = "3") => complete(root, sessionId, NOW, { task_id: taskId });

  function withEntries(root: string, ...entries: readonly Record<string, unknown>[]): void {
    writeLedger(ledgerPath(root), JSON.stringify({ entries }), NOW_S);
  }

  test("the final task cannot close without its evidence, and the reason names the exact call", async () => {
    const { root, sessionId } = listed();
    expect(await closing(root, sessionId)).toEqual(FINAL_BLOCK);
  });

  test("the final task closes with a passing final verification logged for its id", async () => {
    const { root, sessionId } = listed();
    withEntries(root, verdict(sessionId));
    expect(await closing(root, sessionId)).toEqual({});
  });

  test("a final verification logged for another task id does not count", async () => {
    const { root, sessionId } = listed();
    withEntries(root, verdict(sessionId, { task_id: "2" }));
    expect(await closing(root, sessionId)).toEqual(FINAL_BLOCK);
  });

  test("a passing verdict for the same id on another list, or in another run, does not count", async () => {
    const { root, sessionId } = listed();
    withEntries(root, verdict(".omca/state/tasks"), verdict("omca-other-checkout-1a2b3c4d"), verdict(sessionId, { run: "earlier-run" }));
    expect(await closing(root, sessionId)).toEqual(FINAL_BLOCK);
  });

  test("a passing verdict logged without its run and list does not count", async () => {
    const { root, sessionId } = listed();
    const { run: _run, task_list: _list, ...unstamped } = verdict(sessionId);
    withEntries(root, unstamped);
    expect(await closing(root, sessionId)).toEqual(FINAL_BLOCK);
  });

  test("a final verification with no task id does not count", async () => {
    const { root, sessionId } = listed();
    const { task_id: _taskId, ...unscoped } = verdict(sessionId);
    withEntries(root, unscoped);
    expect(await closing(root, sessionId)).toEqual(FINAL_BLOCK);
  });

  test("a failing final verification for its id does not count", async () => {
    const { root, sessionId } = listed();
    withEntries(root, verdict(sessionId, { exit_code: 1 }));
    expect(await closing(root, sessionId)).toEqual(FINAL_BLOCK);
  });

  test("another evidence type naming its id does not count", async () => {
    const { root, sessionId } = listed();
    withEntries(root, verdict(sessionId, { type: "test" }));
    expect(await closing(root, sessionId)).toEqual(FINAL_BLOCK);
  });

  test("a task that is not final closes with no final verification", async () => {
    const { root, sessionId } = listed();
    expect(await closing(root, sessionId, "1")).toEqual({});
  });

  test("a task id not on the list and a payload with an empty task id close", async () => {
    const { root, sessionId } = listed();
    expect(await closing(root, sessionId, "99")).toEqual({});
    expect(await closing(root, sessionId, "")).toEqual({});
  });

  test("the list is the one the mod's marker names", async () => {
    const { root } = listed("omca-shared");
    const sessionId = crypto.randomUUID();
    writeLedger(join(root, ".omca", "state", "mod", `${sessionId}.json`), JSON.stringify({ written_at: NOW, task_list: "omca-shared" }), NOW_S);
    expect(await closing(root, sessionId)).toEqual(FINAL_BLOCK);
  });

  test("a ledger the reader refuses blocks as invalid", async () => {
    const { root, sessionId } = listed();
    writeLedger(ledgerPath(root), "{not json", NOW_S);
    expect(await closing(root, sessionId)).toEqual(INVALID_BLOCK);
  });

  test("a ledger path that cannot be read blocks as invalid, never opens the gate", async () => {
    const { root, sessionId } = listed();
    mkdirSync(ledgerPath(root), { recursive: true });
    expect(await closing(root, sessionId)).toEqual(INVALID_BLOCK);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a ledger with no read permission blocks as invalid", async () => {
    const { root, sessionId } = listed();
    withEntries(root, verdict(sessionId));
    chmodSync(ledgerPath(root), 0o000);
    expect(await closing(root, sessionId)).toEqual(INVALID_BLOCK);
  });

  test("with no marker, the final task on the session's own list still blocks", async () => {
    const listId = process.env.CLAUDE_CODE_TASK_LIST_ID;
    delete process.env.CLAUDE_CODE_TASK_LIST_ID;
    try {
      const { sessionId } = listed();
      const root = project();
      expect(await closing(root, sessionId)).toEqual(FINAL_BLOCK);
    } finally {
      if (listId !== undefined) process.env.CLAUDE_CODE_TASK_LIST_ID = listId;
    }
  });

  test("a malformed entry beside the verdict does not hide it", async () => {
    const { root, sessionId } = listed();
    withEntries(root, { type: "test" }, verdict(sessionId));
    expect(await closing(root, sessionId)).toEqual({});
  });

  test("final-verification in OMCA_DISABLED_HOOKS lets the final task close, and the unlogged check still runs", async () => {
    const { root, sessionId } = listed();
    process.env.OMCA_DISABLED_HOOKS = "final-verification";
    expect(await closing(root, sessionId)).toEqual({});
    await record(root, sessionId);
    expect(await closing(root, sessionId)).toEqual(BLOCK);
  });

  test("task-completed in OMCA_DISABLED_HOOKS turns off the final check too", async () => {
    const { root, sessionId } = listed();
    process.env.OMCA_DISABLED_HOOKS = "task-completed";
    expect(await closing(root, sessionId)).toEqual({});
  });

  test("the final check runs first: an unlogged verification does not change the answer", async () => {
    const { root, sessionId } = listed();
    await record(root, sessionId);
    expect(await closing(root, sessionId)).toEqual(FINAL_BLOCK);
  });

  test("the proof is read from the ledger, then the unlogged verification check runs", async () => {
    const { root, sessionId } = listed();
    withEntries(root, verdict(sessionId));
    await record(root, sessionId);
    expect(await closing(root, sessionId)).toEqual(BLOCK);
  });
});

describe("a full hook payload", () => {
  test("a full payload with nothing recorded answers nothing", async () => {
    const fixture = { hook_event_name: "TaskCompleted", task_description: "Implement feature X", session_id: "fixture-sid-101" };
    expect(await dispatch({ ...fixture, event: fixture.hook_event_name }, project(), NOW)).toEqual({});
  });
});
