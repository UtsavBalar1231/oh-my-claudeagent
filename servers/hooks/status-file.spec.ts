import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { taskListIdFor } from "../../src/core/native-tasks.ts";
import { dispatch } from "./registry.ts";
import { ledgerPath, readOpenRun, readTasks, STAMP_INTERVAL_MS, statusPath } from "./status-file.ts";

const NOW = 1_786_000_000_000;
const NOW_S = NOW / 1000;
const roots: string[] = [];

afterEach(() => {
  delete process.env.CLAUDE_CODE_TASK_LIST_ID;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-status-"));
  roots.push(root);
  return root;
}

const status = (root: string, sessionId: string) => JSON.parse(readFileSync(statusPath(root, sessionId), "utf8"));
const stop = (root: string, sessionId: string, now: number) => dispatch({ event: "Stop", session_id: sessionId }, root, now);

describe("hook stamp", () => {
  test("the first hook call of a session writes last_hook_at with no verification", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await stop(root, sessionId, NOW);
    expect(status(root, sessionId)).toEqual({ session_id: sessionId, last_hook_at: NOW_S, verification: null });
    expect(readdirSync(dirname(statusPath(root, sessionId)))).toEqual([`${sessionId}.json`]);
  });

  test("last_hook_at is stamped at most once per 5 s per session", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    const stamps = [];
    for (const offset of [0, 1_000, STAMP_INTERVAL_MS - 1, STAMP_INTERVAL_MS, STAMP_INTERVAL_MS + 4_000, 2 * STAMP_INTERVAL_MS]) {
      await stop(root, sessionId, NOW + offset);
      stamps.push(status(root, sessionId).last_hook_at);
    }
    expect(stamps).toEqual([NOW_S, NOW_S, NOW_S, NOW_S + 5, NOW_S + 5, NOW_S + 10]);
  });

  test("each session keeps its own throttle and its own file", async () => {
    const root = project();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await stop(root, first, NOW);
    await stop(root, second, NOW + 1_000);
    expect([status(root, first).last_hook_at, status(root, second).last_hook_at]).toEqual([NOW_S, NOW_S + 1]);
  });

  test("a call without a session id writes nothing", async () => {
    const root = project();
    await dispatch({ event: "Stop" }, root, NOW);
    expect(readdirSync(root)).toEqual([]);
  });

  test("a recorder update rewrites the file at once and restarts the throttle", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await stop(root, sessionId, NOW);
    const bash = { event: "PostToolUse", session_id: sessionId, tool_name: "Bash", tool_input: { command: "just test" } };
    await dispatch(bash, root, NOW + 2_000);
    await stop(root, sessionId, NOW + 6_000);
    expect(status(root, sessionId)).toEqual({
      session_id: sessionId,
      last_hook_at: NOW_S + 2,
      verification: { command: "just test", at: NOW_S + 2, exit_code: null, evidence_logged: false },
    });
  });

  test("evidence_logged turns true on the next stamp once the ledger postdates the verification", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await dispatch({ event: "PostToolUse", session_id: sessionId, tool_name: "Bash", tool_input: { command: "just test" } }, root, NOW);
    mkdirSync(dirname(ledgerPath(root)), { recursive: true });
    writeFileSync(ledgerPath(root), '{"entries":[]}');
    utimesSync(ledgerPath(root), NOW_S + 3, NOW_S + 3);
    await stop(root, sessionId, NOW + STAMP_INTERVAL_MS);
    expect(status(root, sessionId).verification).toEqual({ command: "just test", at: NOW_S, exit_code: null, evidence_logged: true });
  });

  test("a failed stamp is logged and the hook answer still stands", async () => {
    const root = project();
    writeFileSync(join(root, ".omca"), "a file where the state directory belongs");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const deny = {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" },
      };
      const registry = { PreToolUse: [["guard", () => deny]] as const };
      const sessionId = crypto.randomUUID();
      expect(await dispatch({ event: "PreToolUse", session_id: sessionId }, root, NOW, registry)).toEqual(deny);
      expect(errors.mock.calls[0]?.[0]).toBe(`omca: could not stamp the status file for session ${sessionId}:`);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("session id validation", () => {
  test("a UUID and the fixture ids map to a file under .omca/state/session", () => {
    const id = crypto.randomUUID();
    expect(statusPath("/p", id)).toBe(join("/p", ".omca", "state", "session", `${id}.json`));
    expect(statusPath("/p", "fixture-sid-001")).toBe(join("/p", ".omca", "state", "session", "fixture-sid-001.json"));
  });

  test.each(["", "..", "../escape", "a/b", "a\0b", ".hidden", "a.json", "x".repeat(129)])("rejects %p before it reaches a path", (id) => {
    expect(() => statusPath("/p", id)).toThrow("unsafe session id in a state path");
  });

  test("an unsafe session id on a hook call writes nothing and is reported", async () => {
    const root = project();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await stop(root, "../../etc/x", NOW)).toEqual({});
      expect(errors.mock.calls).toEqual([['omca: ignoring hook session state for an unsafe session id "../../etc/x"']]);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the native task list", () => {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  let config: string;

  beforeEach(() => {
    config = project();
    process.env.CLAUDE_CONFIG_DIR = config;
  });

  afterEach(() => {
    if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  function listFile(listId: string, name: string, content: string): string {
    process.env.CLAUDE_CODE_TASK_LIST_ID = listId;
    const path = join(config, "tasks", listId, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  const stored = (id: string, metadata: Record<string, unknown> = { run: "demo" }) => JSON.stringify({ id, subject: `Task ${id}`, status: "pending", metadata });
  const ids = (root: string, sessionId: string) => {
    process.env.CLAUDE_CODE_TASK_LIST_ID = sessionId;
    return readTasks(root, sessionId).map(({ id }) => id);
  };

  test("with no marker yet, at prompt time, as on the first prompt after /clear, it reads the list the mod is about to name", () => {
    const root = project();
    listFile(taskListIdFor(root), "1.json", stored("1"));
    delete process.env.CLAUDE_CODE_TASK_LIST_ID;
    const atPrompt = { atPrompt: true };
    expect(readTasks(root, crypto.randomUUID(), atPrompt).map(({ id }) => id)).toEqual(["1"]);
    process.env.CLAUDE_CODE_TASK_LIST_ID = "named-at-launch";
    listFile("named-at-launch", "2.json", stored("2"));
    expect(readTasks(root, crypto.randomUUID(), atPrompt).map(({ id }) => id)).toEqual(["2"]);
  });

  test("with no marker on any other event, it reads the session's own list unless the environment names one", () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    listFile(taskListIdFor(root), "1.json", stored("1"));
    listFile(sessionId, "2.json", stored("2"));
    delete process.env.CLAUDE_CODE_TASK_LIST_ID;
    expect(readTasks(root, sessionId).map(({ id }) => id)).toEqual(["2"]);
    process.env.CLAUDE_CODE_TASK_LIST_ID = taskListIdFor(root);
    expect(readTasks(root, sessionId).map(({ id }) => id)).toEqual(["1"]);
  });

  test("a missing directory is an empty list", () => {
    expect(readTasks(project(), crypto.randomUUID())).toEqual([]);
  });

  test("tasks come back in numeric id order, and each is parsed", () => {
    const sessionId = crypto.randomUUID();
    for (const id of ["10", "2", "1"]) listFile(sessionId, `${id}.json`, stored(id));
    const root = project();
    expect(ids(root, sessionId)).toEqual(["1", "2", "10"]);
    expect(readTasks(root, sessionId)[0]).toMatchObject({ id: "1", subject: "Task 1", status: "pending", run: "demo", isFinal: false });
  });

  test("a malformed file, a directory named like a task and a file that is not JSON are skipped", () => {
    const sessionId = crypto.randomUUID();
    listFile(sessionId, "1.json", stored("1"));
    listFile(sessionId, "2.json", "{torn");
    listFile(sessionId, "notes.txt", stored("3"));
    listFile(sessionId, ".highwatermark", "4");
    mkdirSync(join(config, "tasks", sessionId, "5.json"));
    expect(ids(project(), sessionId)).toEqual(["1"]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable file is skipped (skipped on Windows and as root: chmod 000 does not refuse there)", () => {
    const sessionId = crypto.randomUUID();
    listFile(sessionId, "1.json", stored("1"));
    chmodSync(listFile(sessionId, "2.json", stored("2")), 0o000);
    expect(ids(project(), sessionId)).toEqual(["1"]);
  });

  test("a task list path that is a file reads as empty", () => {
    const sessionId = crypto.randomUUID();
    mkdirSync(join(config, "tasks"), { recursive: true });
    writeFileSync(join(config, "tasks", sessionId), "not a directory");
    expect(readTasks(project(), sessionId)).toEqual([]);
  });

  test("the marker's task_list wins over the session id, and a marker naming none falls back", () => {
    const root = project();
    const named = crypto.randomUUID();
    const unnamed = crypto.randomUUID();
    listFile("omca-shared", "1.json", stored("1"));
    listFile(named, "2.json", stored("2"));
    listFile(unnamed, "3.json", stored("3"));
    mkdirSync(join(root, ".omca", "state", "mod"), { recursive: true });
    writeFileSync(join(root, ".omca", "state", "mod", `${named}.json`), JSON.stringify({ written_at: NOW, task_list: "omca-shared" }));
    writeFileSync(join(root, ".omca", "state", "mod", `${unnamed}.json`), JSON.stringify({ written_at: NOW, task_list: null }));
    expect(ids(root, named)).toEqual(["1"]);
    expect(ids(root, unnamed)).toEqual(["3"]);
  });

  test("an id that could climb out of the tasks directory is cut to a safe name", () => {
    const root = project();
    listFile("---escape", "1.json", stored("1"));
    expect(ids(root, "../escape")).toEqual(["1"]);
  });

  test("the open run names its count and next task, and is undefined once nothing is open or no task has a run", () => {
    const root = project();
    const open = crypto.randomUUID();
    listFile(open, "1.json", stored("1"));
    listFile(open, "2.json", stored("2"));
    expect(readOpenRun(root, open)).toMatchObject({ name: "demo", open: [{ id: "1" }, { id: "2" }], next: { id: "1" } });
    const closed = crypto.randomUUID();
    listFile(closed, "1.json", stored("1", { run: "demo", blocked: "no key" }));
    expect(readOpenRun(root, closed)).toBeUndefined();
    const adHoc = crypto.randomUUID();
    listFile(adHoc, "1.json", stored("1", {}));
    expect(readOpenRun(root, adHoc)).toBeUndefined();
  });
});
