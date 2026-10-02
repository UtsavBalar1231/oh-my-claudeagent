import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-task-completed-"));
  roots.push(root);
  return root;
}

const record = (root: string, sessionId: string, now = NOW, toolResponse: unknown = undefined) =>
  dispatch(
    { event: "PostToolUse", session_id: sessionId, tool_name: "Bash", tool_input: { command: "just test" }, tool_response: toolResponse },
    root,
    now,
  );

const complete = (root: string, sessionId: string, now = NOW, task: Record<string, unknown> = { task_description: "anything" }) =>
  dispatch({ event: "TaskCompleted", session_id: sessionId, ...task }, root, now);

function writeLedger(path: string, content: string, mtimeSeconds: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeSeconds, mtimeSeconds);
}

describe("nothing recorded allows, whatever the task is named", () => {
  test("no slot, informational task: exits 0 (allow)", async () => {
    expect(await complete(project(), crypto.randomUUID(), NOW, { task_description: "status report only" })).toEqual({});
  });

  test("no slot, verification-sounding task: exits 0 (allow)", async () => {
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
  test("slot with evidence logged after it: exits 0 (allow)", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, NOW - 60 * SECOND);
    writeLedger(ledgerPath(root), LEDGER, NOW_S);
    expect(await complete(root, sessionId)).toEqual({});
  });

  test("slot ordering: evidence logged after the verification allows", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, NOW - 60 * SECOND);
    writeLedger(ledgerPath(root), LEDGER, NOW_S - 30);
    expect(await complete(root, sessionId)).toEqual({});
  });

  test("evidence written in the same second as the verification allows", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId);
    writeLedger(ledgerPath(root), LEDGER, NOW_S);
    expect(await complete(root, sessionId)).toEqual({});
  });
});

describe("a verification with no evidence after it blocks", () => {
  test("slot with no evidence at all: exits 2 (block) and names the command", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId);
    expect(await complete(root, sessionId, NOW, { task_description: "status report only" })).toEqual(BLOCK);
  });

  test("true positive: a recorded verification with no evidence after it blocks", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId);
    expect(await complete(root, sessionId, NOW + 30 * SECOND, { task_description: "anything at all" })).toEqual(BLOCK);
  });

  test("evidence older than the slot: exits 2 (block)", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    writeLedger(ledgerPath(root), LEDGER, NOW_S - 600);
    await record(root, sessionId);
    expect(await complete(root, sessionId)).toEqual(BLOCK);
  });

  test("true positive: a failing verification with stale evidence still blocks", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    writeLedger(ledgerPath(root), LEDGER, NOW_S - 120);
    await record(root, sessionId, NOW, { exitCode: 1 });
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

describe("an evidence ledger the gate cannot trust blocks", () => {
  test("slot ordering: evidence postdating the slot but schema-invalid blocks", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, NOW - 60 * SECOND);
    writeLedger(ledgerPath(root), '{"entries":[{"type":"test"}]}', NOW_S);
    expect(await complete(root, sessionId)).toEqual(INVALID_BLOCK);
  });

  test("an unparseable ledger postdating the slot blocks as invalid", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, NOW - 60 * SECOND);
    writeLedger(ledgerPath(root), "{not json", NOW_S);
    expect(await complete(root, sessionId)).toEqual(INVALID_BLOCK);
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
    process.env.OMCA_DISABLED_HOOKS = "task-completed-verify";
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

describe("golden fixtures", () => {
  test("no-evidence replays to an empty answer", async () => {
    const fixture = { hook_event_name: "TaskCompleted", task_description: "Implement feature X", session_id: "fixture-sid-101" };
    expect(await dispatch({ ...fixture, event: fixture.hook_event_name }, project(), NOW)).toEqual({});
  });

  test("with-evidence replays to an empty answer over the seeded legacy ledger", async () => {
    const root = project();
    writeLedger(
      join(root, ".omca", "state", "verification-evidence.json"),
      '{"entries":[{"type":"test","command":"just test","exit_code":0,"output_snippet":"10 passed","timestamp":"2026-01-01T00:00:00Z"}]}',
      NOW_S - 600,
    );
    const fixture = { hook_event_name: "TaskCompleted", task_description: "Implement feature X", session_id: "fixture-sid-102" };
    expect(await dispatch({ ...fixture, event: fixture.hook_event_name }, root, NOW)).toEqual({});
  });
});
