import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTasks, parseTask } from "../src/core/native-tasks.ts";
import { LEDGER } from "../src/core/omca-paths.ts";
import { readTaskFiles, TASK_FILE_BYTE_LIMIT, TASK_LIMIT, TASKS_DIR } from "./state.ts";
import { withLock } from "../servers/io.ts";
import { createTask, tasksLock, updateTask, type TaskChange } from "./tasks.ts";

let root: string;
const savedSwitch = process.env.OMCA_DISABLED_HOOKS;

beforeEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "omca-tasks-")));
});
afterEach(() => {
  if (savedSwitch === undefined) delete process.env.OMCA_DISABLED_HOOKS;
  else process.env.OMCA_DISABLED_HOOKS = savedSwitch;
  rmSync(root, { recursive: true, force: true });
});

const ready = async () => {};
const create = (subject = "Do it", metadata: Record<string, unknown> = { run: "work" }) => createTask(root, { subject, description: "Done when it passes", activeForm: "", metadata }, ready);
const update = (change: TaskChange) => updateTask(root, change, ready);
const stored = (id: string) => JSON.parse(readFileSync(join(root, TASKS_DIR, `${id}.json`), "utf8")) as Record<string, unknown>;
const list = () => readTaskFiles(root).tasks;

function ledger(...entries: Record<string, unknown>[]): void {
  mkdirSync(join(root, ".omca", "evidence"), { recursive: true });
  writeFileSync(join(root, LEDGER), JSON.stringify({ version: 1, entries: entries.map((entry) => ({ type: "final_verification", command: "review", exit_code: 0, output_snippet: "ok", timestamp: "2026-11-05T10:00:00Z", run: "work", task_list: TASKS_DIR, ...entry })) }));
}

async function finalRun() {
  await create("Work");
  await create("Final verification", { run: "work", final: true });
}

describe("creating a task", () => {
  test("writes Claude Code's task file shape, which the shared reader parses", async () => {
    const task = await create("Add it", { run: "work", owner_note: "x" });
    expect(stored("1")).toEqual({ id: "1", subject: "Add it", description: "Done when it passes", activeForm: "", status: "pending", owner: "", blocks: [], blockedBy: [], metadata: { run: "work", owner_note: "x" } });
    expect(parseTask(readFileSync(join(root, TASKS_DIR, "1.json"), "utf8"))).toEqual(task);
    expect(task).toMatchObject({ id: "1", run: "work", isFinal: false, blockedReason: "" });
  });

  test("parallel creates get distinct ids", async () => {
    await Promise.all([create("a"), create("b"), create("c"), create("d")]);
    expect(list().map(({ id }) => id)).toEqual(["1", "2", "3", "4"]);
    expect(list().map(({ subject }) => subject).sort()).toEqual(["a", "b", "c", "d"]);
  });

  test.each([
    ["a create", (gate: () => Promise<void>) => createTask(root, { subject: "x", description: "y", activeForm: "", metadata: { run: "work" } }, gate)],
    ["an update", (gate: () => Promise<void>) => updateTask(root, { taskId: "1", status: "in_progress" }, gate)],
  ])("%s waits for the lock before it checks or writes", async (_name, write) => {
    await create();
    let release!: () => void;
    const held = withLock(tasksLock(root), () => new Promise<void>((resolve) => { release = resolve; }));
    let reached = false;
    const pending = write(async () => { reached = true; });
    await Bun.sleep(30);
    expect(reached).toBe(false);
    expect(list()).toHaveLength(1);
    release();
    await held;
    await pending;
    expect(reached).toBe(true);
  });

  test("a task over the size limit is refused and leaves nothing behind", async () => {
    await expect(createTask(root, { subject: "big", description: "x".repeat(TASK_FILE_BYTE_LIMIT), activeForm: "", metadata: { run: "work" } }, ready)).rejects.toThrow(`${TASK_FILE_BYTE_LIMIT}-byte limit`);
    expect(list()).toEqual([]);
  });

  test("a full list is refused while any of it is open", async () => {
    mkdirSync(join(root, TASKS_DIR), { recursive: true });
    for (let id = 1; id <= TASK_LIMIT; id += 1) writeFileSync(join(root, TASKS_DIR, `${id}.json`), JSON.stringify({ id: String(id), subject: "t", status: "pending", metadata: { run: "work" } }));
    await expect(create()).rejects.toThrow(`${TASK_LIMIT}-task limit`);
  });

  test("the first task after a finished run clears that run and never reuses its ids", async () => {
    await create("old one");
    await create("old two");
    await update({ taskId: "1", status: "completed" });
    await update({ taskId: "2", metadata: { blocked: "no access" } });
    const task = await create("new", { run: "next" });
    expect(task.id).toBe("3");
    expect(list().map(({ id }) => id)).toEqual(["3"]);
    expect(readFileSync(join(root, TASKS_DIR, ".highwatermark"), "utf8")).toBe("3");
    await update({ taskId: "3", status: "deleted" });
    expect((await create("after delete", { run: "next" })).id).toBe("4");
  });

  test.each([
    ["is over the size limit", { description: "x".repeat(TASK_FILE_BYTE_LIMIT), metadata: { run: "next" } }, `${TASK_FILE_BYTE_LIMIT}-byte limit`],
    ["would be hidden by metadata._internal", { description: "y", metadata: { run: "next", _internal: true } }, "no longer read as a task"],
  ])("a create that %s leaves a finished run and the id counter as they were", async (_name, fields, message) => {
    await create("old");
    await update({ taskId: "1", status: "completed" });
    await expect(createTask(root, { subject: "new", activeForm: "", ...fields }, ready)).rejects.toThrow(message);
    expect(list().map(({ id }) => id)).toEqual(["1"]);
    expect(readFileSync(join(root, TASKS_DIR, ".highwatermark"), "utf8")).toBe("1");
    expect(readdirSync(join(root, TASKS_DIR)).sort()).toEqual([".highwatermark", "1.json"]);
  });

  test("a run with an open task is kept when another task joins", async () => {
    await create("open");
    await create("new", { run: "next" });
    expect(list().map(({ id }) => id)).toEqual(["1", "2"]);
  });

  test("the write is checked once the lock is held", async () => {
    const refused = createTask(root, { subject: "x", description: "y", activeForm: "", metadata: { run: "work" } }, async () => { throw new Error("session moved"); });
    await expect(refused).rejects.toThrow("session moved");
    expect(existsSync(join(root, TASKS_DIR))).toBe(false);
  });

  test.skipIf(process.platform === "win32")("refuses a state directory that links outside the checkout", async () => {
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "omca-outside-")));
    try {
      symlinkSync(outside, join(root, ".omca"));
      await expect(create()).rejects.toThrow("symlink");
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("updating a task", () => {
  test("sets fields, and merges metadata with null removing a key", async () => {
    await create("Work", { run: "work", note: "x", keep: 1 });
    const task = await update({ taskId: "1", status: "in_progress", subject: "Renamed", owner: "omca-executor", metadata: { note: null, added: "y" } });
    expect(task).toMatchObject({ subject: "Renamed", status: "in_progress", owner: "omca-executor" });
    expect(stored("1").metadata).toEqual({ run: "work", keep: 1, added: "y" });
  });

  test("links both ways, once, in either direction", async () => {
    await create("a");
    await create("b");
    await create("c");
    await update({ taskId: "3", addBlockedBy: ["1", "1"] });
    await update({ taskId: "2", addBlocks: ["3"] });
    expect(stored("3").blockedBy).toEqual(["1", "2"]);
    expect(stored("1").blocks).toEqual(["3"]);
    expect(stored("2").blocks).toEqual(["3"]);
  });

  test("deleting removes the task and every link to it", async () => {
    await create("a");
    await create("b");
    await update({ taskId: "2", addBlockedBy: ["1"] });
    expect(await update({ taskId: "1", status: "deleted" })).toBeNull();
    expect(list().map(({ id }) => id)).toEqual(["2"]);
    expect(stored("2").blockedBy).toEqual([]);
  });

  test.each([
    ["an unknown task", { taskId: "9", status: "completed" as const }, "Task #9 is not on the list"],
    ["an unknown blocker", { taskId: "1", addBlockedBy: ["9"] }, "Task #9 is not on the list"],
    ["a task blocking itself", { taskId: "1", addBlocks: ["1"] }, "Task #1 cannot block itself"],
  ])("refuses %s and changes nothing", async (_name, change, message) => {
    await create();
    const before = stored("1");
    await expect(update(change)).rejects.toThrow(message);
    expect(stored("1")).toEqual(before);
  });
});

describe("the final task", () => {
  test("refuses completion without a verdict and names how to log one", async () => {
    await finalRun();
    await expect(update({ taskId: "2", status: "completed" })).rejects.toThrow(`omca_evidence_log(evidence_type="final_verification", command="<what the review covered>", output_snippet="<the verdict>", task_id="2", exit_code=0)`);
    expect(stored("2").status).toBe("pending");
  });

  test.each([
    ["a failing verdict", { task_id: "2", exit_code: 1 }],
    ["a verdict for another task", { task_id: "1" }],
    ["a verdict naming no task", {}],
    ["a passing check of another type", { type: "test", task_id: "2" }],
    ["a verdict for the same id on Claude Code's list", { task_id: "2", task_list: "omca-checkout-1a2b3c4d" }],
    ["a verdict for the same id in another run", { task_id: "2", run: "earlier" }],
    ["a verdict logged without its run and list", { task_id: "2", run: undefined, task_list: undefined }],
  ])("%s does not close it", async (_name, entry) => {
    await finalRun();
    ledger(entry);
    await expect(update({ taskId: "2", status: "completed" })).rejects.toThrow("no passing final verification names it");
  });

  test("a passing verdict naming it closes it", async () => {
    await finalRun();
    ledger({ task_id: "2", exit_code: 1 }, { task_id: "2" });
    expect(await update({ taskId: "2", status: "completed" })).toMatchObject({ status: "completed" });
  });

  test.each([
    ["deleted", { taskId: "2", status: "deleted" as const }],
    ["closed as blocked", { taskId: "2", metadata: { blocked: "cannot finish" } }],
  ])("cannot be %s without a verdict, and can with one of any outcome", async (_name, change) => {
    await finalRun();
    await expect(update(change)).rejects.toThrow("no final verification names it");
    expect(stored("2").status).toBe("pending");
    ledger({ task_id: "2", exit_code: 1 });
    await update(change);
    if ("status" in change) expect(list().map(({ id }) => id)).toEqual(["1"]);
    else expect(list().find(({ id }) => id === "2")?.blockedReason).toBe("cannot finish");
  });

  test.each([[null], [false]])("cannot be unmarked with final: %j to dodge the verdict", async (value) => {
    await finalRun();
    await expect(update({ taskId: "2", metadata: { final: value } })).rejects.toThrow("it stays final");
    expect(list().find(({ id }) => id === "2")?.isFinal).toBe(true);
  });

  test.each([
    ["marking it internal", { _internal: true }],
    ["marking it internal with a truthy string", { _internal: "yes" }],
  ])("%s would hide it from every reader, so nothing is written", async (_name, metadata) => {
    await finalRun();
    const before = stored("2");
    await expect(update({ taskId: "2", metadata })).rejects.toThrow("no longer read as a task");
    expect(stored("2")).toEqual(before);
    expect(list().find(({ id }) => id === "2")?.isFinal).toBe(true);
  });

  test("an ordinary task cannot be hidden either", async () => {
    await finalRun();
    const before = stored("1");
    await expect(update({ taskId: "1", metadata: { _internal: true } })).rejects.toThrow("no longer read as a task");
    expect(stored("1")).toEqual(before);
  });

  test("cannot be moved out of its run", async () => {
    await finalRun();
    const before = stored("2");
    await expect(update({ taskId: "2", metadata: { run: null } })).rejects.toThrow("it stays final");
    await expect(update({ taskId: "2", metadata: { run: "elsewhere" } })).rejects.toThrow("it stays final");
    expect(stored("2")).toEqual(before);
  });

  test("completing it checks the verdict whatever else the change carries", async () => {
    await finalRun();
    ledger({ task_id: "2", exit_code: 1 });
    const before = stored("2");
    await expect(update({ taskId: "2", status: "completed", metadata: { blocked: "gap" } })).rejects.toThrow("no passing final verification names it");
    expect(stored("2")).toEqual(before);
    ledger({ task_id: "2", exit_code: 1 }, { task_id: "2" });
    expect(await update({ taskId: "2", status: "completed", metadata: { blocked: "gap" } })).toMatchObject({ status: "completed", blockedReason: "gap" });
  });

  test("an unparsable ledger refuses rather than passes", async () => {
    await finalRun();
    mkdirSync(join(root, ".omca", "evidence"), { recursive: true });
    writeFileSync(join(root, LEDGER), "not json");
    await expect(update({ taskId: "2", status: "completed" })).rejects.toThrow("invalid schema");
  });

  test("other changes pass, and so does any change to an ordinary task", async () => {
    await finalRun();
    expect(await update({ taskId: "2", status: "in_progress", addBlockedBy: ["1"] })).toMatchObject({ status: "in_progress" });
    expect(await update({ taskId: "1", status: "completed" })).toMatchObject({ status: "completed" });
  });

  test("the final-verification kill switch turns the hold off", async () => {
    await finalRun();
    process.env.OMCA_DISABLED_HOOKS = "final-verification";
    expect(await update({ taskId: "2", status: "completed" })).toMatchObject({ status: "completed" });
    expect(await update({ taskId: "2", metadata: { final: null } })).toMatchObject({ isFinal: false });
  });
});

describe("the list as the model reads it", () => {
  test("names each run, the final task, open blockers and why a task was closed", async () => {
    await create("Done");
    await create("Stuck");
    await create("Waiting");
    await create("Final verification", { run: "work", final: true });
    await update({ taskId: "1", status: "completed" });
    await update({ taskId: "2", metadata: { blocked: "no access" } });
    await update({ taskId: "4", addBlockedBy: ["1", "2", "3"] });
    await create("Other", { run: "side" });
    expect(formatTasks(list())).toBe([
      "Run work:",
      "#1 [completed] Done",
      "#2 [pending] Stuck [closed as blocked: no access]",
      "#3 [pending] Waiting",
      "#4 [pending] Final verification [final] [waiting on #3]",
      "Run side:",
      "#5 [pending] Other",
    ].join("\n"));
  });

  test("an empty list says so", () => {
    expect(formatTasks([])).toBe("The task list is empty.");
  });
});
