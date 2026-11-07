import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot, STATE_FILE_BYTE_LIMIT, TASK_FILE_BYTE_LIMIT, TASK_LIMIT } from "./state.ts";

let directory: string;
let checkout: string;

function put(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const taskPath = (id: string, root = checkout): string => join(root, ".omca", "state", "tasks", `${id}.json`);
const task = (id: string, metadata: Record<string, unknown> = { run: "work" }, fields: Record<string, unknown> = {}): string =>
  put(taskPath(id), JSON.stringify({ id, subject: `Task ${id}`, description: "", activeForm: "", status: "pending", owner: "", blocks: [], blockedBy: [], metadata, ...fields }));
const FINAL_ID = "2";
const run = (): void => {
  task("1", { run: "work" }, { status: "completed" });
  task(FINAL_ID, { run: "work", final: true }, { blockedBy: ["1"] });
};
const ledgerPath = (): string => join(checkout, ".omca", "evidence", "verification-evidence.json");
const ledger = (entries: unknown[]): void => { put(ledgerPath(), JSON.stringify({ version: 1, entries })); };
const evidence = (taskId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "final_verification", command: "bun test", exit_code: 0, timestamp: "2026-10-15T10:00:00Z", output_snippet: "Passed", ...(taskId && { task_id: taskId }), ...overrides,
});

beforeEach(() => {
  const preferred = join(homedir(), ".cache", "tmp", "opencode");
  directory = fs.realpathSync.native(mkdtempSync(join(existsSync(preferred) ? preferred : tmpdir(), "omca-state-")));
  checkout = join(directory, "checkout");
  mkdirSync(checkout);
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe("native session snapshots", () => {
  test("missing state is observable and snapshots never create .omca", () => {
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.run).toBeNull();
    expect(snapshot.evidence.verdict).toBe("missing");
    expect(snapshot.health).toContainEqual({ name: "tasks", state: "warning", detail: "This checkout has no run on its task list" });
    expect(snapshot.health).toContainEqual({ name: "ledger", state: "warning", detail: "Evidence ledger is missing" });
    expect(existsSync(join(checkout, ".omca"))).toBe(false);
  });

  test("every session in a checkout reads the same run, and another checkout reads none", () => {
    run();
    const other = join(directory, "other");
    mkdirSync(other);
    expect(readSnapshot(checkout, "ses_one").run?.name).toBe("work");
    expect(readSnapshot(checkout, "ses_two").run?.name).toBe("work");
    expect(readSnapshot(other, "ses_one").run).toBeNull();
  });

  test.skipIf(process.platform === "win32")("reads a run through the session checkout's aliased ancestor", () => {
    run();
    const alias = join(directory, "alias");
    symlinkSync(checkout, alias);
    expect(readSnapshot(alias, "ses_one").run?.tasks.map(({ id }) => id)).toEqual(["1", "2"]);
  });

  test("the run shown is the one with an open task, with only its tasks in id order", () => {
    task("10", { run: "second" });
    task("9", { run: "first" }, { status: "completed" });
    task("11", { run: "second" }, { status: "completed" });
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.run?.name).toBe("second");
    expect(snapshot.run?.tasks.map(({ id }) => id)).toEqual(["10", "11"]);
    expect(snapshot.health).toContainEqual({ name: "tasks", state: "ok", detail: "2 tasks in run second" });
  });

  test("a finished run stays on show until another starts", () => {
    task("1", { run: "work" }, { status: "completed" });
    expect(readSnapshot(checkout, "ses_one").run?.name).toBe("work");
  });

  test("a file that does not hold the task it names is counted and left out", () => {
    run();
    put(taskPath("3"), "not json");
    put(taskPath("4"), JSON.stringify({ id: "5", subject: "Wrong file", status: "pending" }));
    put(join(checkout, ".omca", "state", "tasks", ".highwatermark"), "9");
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.run?.tasks.map(({ id }) => id)).toEqual(["1", "2"]);
    expect(snapshot.health).toContainEqual({ name: "tasks", state: "warning", detail: "2 task files could not be read" });
  });

  test("a list that moved to another run since approval is refused, with no notepad read", () => {
    run();
    put(join(checkout, ".omca", "notepads", "work", "issues.md"), "work notes\n");
    const snapshot = readSnapshot(checkout, "ses_one", "approved-run");
    expect(snapshot.run).toBeNull();
    expect(snapshot.notepads).toEqual([]);
    expect(snapshot.health.some((item) => item.name === "tasks" && item.state === "error" && item.detail.includes("changed during inspection"))).toBe(true);
  });

  test("rejects blank native context without falling back to process session", () => {
    expect(readSnapshot(checkout, "").health.some((item) => item.name === "context" && item.state === "error")).toBe(true);
    expect(existsSync(join(checkout, ".omca"))).toBe(false);
  });

  test("refuses redirected state reads", () => {
    const outside = join(directory, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(checkout, ".omca"));
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.health.filter((item) => item.state === "error").map((item) => item.name)).toEqual(["tasks", "ledger"]);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("refuses a task file that links outside the checkout", () => {
    run();
    const outside = put(join(directory, "private.json"), JSON.stringify({ id: "3", subject: "do-not-read-sentinel", status: "pending" }));
    symlinkSync(outside, taskPath("3"));
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.run).toBeNull();
    expect(snapshot.health.some((item) => item.name === "tasks" && item.state === "error")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("do-not-read-sentinel");
  });
});

describe("native input limits", () => {
  function sparse(path: string, size: number): void {
    put(path, "");
    truncateSync(path, size);
  }

  test.each(["ledger", "notepad"])("refuses oversized sparse %s files before reading or parsing", (kind) => {
    run();
    const path = kind === "ledger" ? ledgerPath() : join(checkout, ".omca", "notepads", "work", "issues.md");
    const name = kind === "notepad" ? "notepad:issues" : kind;
    sparse(path, STATE_FILE_BYTE_LIMIT + 1);
    const read = spyOn(fs, "readSync");
    try {
      const snapshot = readSnapshot(checkout, "ses_one");
      expect(snapshot.health.some((item) => item.name === name && item.state === "error" && item.detail.includes(`${STATE_FILE_BYTE_LIMIT}-byte`))).toBe(true);
      expect(snapshot.health.some((item) => item.name === "ledger")).toBe(true);
      expect(snapshot.notepads).toEqual([]);
      expect(read.mock.calls.every(([, buffer]) => (buffer as Buffer).length <= TASK_FILE_BYTE_LIMIT + 1)).toBe(true);
    } finally {
      read.mockRestore();
    }
    expect(statSync(path).size).toBe(STATE_FILE_BYTE_LIMIT + 1);
  });

  test("refuses an oversized task file before reading it", () => {
    run();
    sparse(taskPath("3"), TASK_FILE_BYTE_LIMIT + 1);
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.run).toBeNull();
    expect(snapshot.health.some((item) => item.name === "tasks" && item.state === "error" && item.detail.includes(`${TASK_FILE_BYTE_LIMIT}-byte`))).toBe(true);
  });

  test("admits the task ceiling and refuses a list past it", () => {
    for (let id = 1; id <= TASK_LIMIT; id += 1) task(String(id));
    expect(readSnapshot(checkout, "ses_one").run?.tasks).toHaveLength(TASK_LIMIT);
    task(String(TASK_LIMIT + 1));
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.run).toBeNull();
    expect(snapshot.health.some((item) => item.name === "tasks" && item.state === "error" && item.detail.includes(`${TASK_LIMIT}-task`))).toBe(true);
  });
});

describe("evidence and notepads", () => {
  test("a verdict naming the final task is only historical; one naming no task proves nothing", () => {
    run();
    ledger([evidence("")]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("missing");
    ledger([evidence(FINAL_ID)]);
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.evidence.verdict).toBe("historical");
    expect(snapshot.evidence.entries[0]?.taskId).toBe(FINAL_ID);
    expect(snapshot.health.some((item) => item.name === "verification" && item.state === "warning" && item.detail.includes("not supported"))).toBe(true);
    ledger([evidence("99")]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("stale");
  });

  test("a run without a final task has no verdict to read", () => {
    task("1");
    ledger([evidence("1")]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("missing");
  });

  test("a later entry on a different tree makes a passing verdict stale; one on the same tree does not", () => {
    run();
    ledger([evidence(FINAL_ID, { tree: "a" }), evidence("", { type: "test", tree: "b" })]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("stale");
    ledger([evidence(FINAL_ID, { tree: "a" }), evidence("", { type: "test", tree: "a" })]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("historical");
  });

  test("newer applicable failures invalidate success; another task's failures do not", () => {
    run();
    ledger([evidence(FINAL_ID), evidence("", { type: "test", exit_code: 1 })]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("stale");
    ledger([evidence(FINAL_ID), evidence(FINAL_ID, { type: "test", exit_code: 1 })]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("stale");
    ledger([evidence(FINAL_ID), evidence("99", { type: "test", exit_code: 1 })]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("historical");
  });

  test.each([
    [[0, 1, 0], "historical"],
    [[0, 0, 1], "stale"],
    [[1, 0, 0], "historical"],
    [[1, 0, 1], "stale"],
  ] as const)("uses the newest matching final across relevant results %j", (results, verdict) => {
    run();
    ledger(results.flatMap((exit_code) => [evidence(FINAL_ID, { exit_code }), evidence("99")]));
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe(verdict);
  });

  test("only a newer matching final restores history after an applicable failure", () => {
    run();
    const entries = [evidence(FINAL_ID), evidence("", { type: "test", exit_code: 1 }), evidence("99")];
    ledger(entries);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("stale");
    ledger([...entries, evidence(FINAL_ID), evidence("", { type: "test", exit_code: 0 }), evidence("99", { exit_code: 1 })]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("historical");
  });

  test("a ledger from before task ids keeps its entries and proves no task", () => {
    run();
    ledger([{ type: "final_verification", command: "review", exit_code: 0, timestamp: "2026-10-15T10:00:00Z", output_snippet: "ok", plan_sha256: "a".repeat(64) }]);
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.evidence.entries).toHaveLength(1);
    expect(snapshot.evidence.verdict).toBe("missing");
  });

  test.each(["{", "[]", '{"version":2}', '{"entries":{}}'])("corrupt ledger is distinguishable from missing: %s", (text) => {
    put(ledgerPath(), text);
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.evidence.entries).toEqual([]);
    expect(snapshot.health.some((item) => item.name === "ledger" && item.state === "error")).toBe(true);
    expect(readFileSync(ledgerPath(), "utf8")).toBe(text);
  });

  test("malformed ledger entries are visible without hiding good entries", () => {
    ledger([null, evidence("")]);
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.evidence.entries).toHaveLength(1);
    expect(snapshot.health.some((item) => item.name === "ledger" && item.state === "warning")).toBe(true);
  });

  test("bounds newest evidence and per-section notepads, and redacts before truncation", async () => {
    run();
    ledger(Array.from({ length: 60 }, (_, index) => evidence("", { command: `run ${index} api_key=private-value`, output_snippet: "token=private-value " + "x".repeat(3_000) })));
    put(join(checkout, ".omca", "notepads", "work", "learnings.md"), `## 2026-10-14T10:00:00Z\n\n${"old\n".repeat(3_000)}\n## 2026-10-15T10:00:00Z\n\ntoken=private-value newest\n`);
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.evidence.entries).toHaveLength(50);
    expect(snapshot.evidence.entries[0]?.command).toBe("run 10 api_key=<masked>");
    expect(snapshot.evidence.entries.at(-1)?.command).toBe("run 59 api_key=<masked>");
    expect(snapshot.evidence.entries.every((entry) => entry.snippet.length <= 2_000)).toBe(true);
    expect(snapshot.notepads[0]?.content.length).toBeLessThanOrEqual(8_000);
    expect(snapshot.notepads[0]?.content).toContain("token=<masked> newest");
    expect(JSON.stringify(snapshot)).not.toContain("private-value");
  });

  test("does not read notepad symlinks outside the checkout", async () => {
    run();
    const outside = put(join(directory, "private.md"), "do-not-read-sentinel");
    mkdirSync(join(checkout, ".omca", "notepads", "work"), { recursive: true });
    symlinkSync(outside, join(checkout, ".omca", "notepads", "work", "issues.md"));
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.notepads).toEqual([]);
    expect(snapshot.health.some((item) => item.name === "notepad:issues" && item.state === "error")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("do-not-read-sentinel");
  });
});
