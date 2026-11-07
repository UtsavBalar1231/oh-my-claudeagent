import { describe, expect, test } from "bun:test";
import { groupTasks, isOpen, type NativeTask, openBlockers, parseTask, runState, taskListDir, taskListIdFor, withHistory } from "./native-tasks.ts";

const task = (id: string, status: NativeTask["status"], blockedBy: string[] = []): NativeTask => ({
  id,
  subject: `Task ${id}`,
  description: "",
  activeForm: "",
  status,
  owner: "",
  blocks: [],
  blockedBy,
  run: "",
  isFinal: false,
  blockedReason: "",
  details: [],
});

const stored = (fields: Record<string, unknown>) => JSON.stringify({ id: "2", subject: "Port the parser", status: "pending", ...fields });

describe("parseTask", () => {
  test("reads every field Claude Code stores", () => {
    const text = stored({
      description: "Move it over.",
      activeForm: "Porting the parser",
      status: "in_progress",
      owner: "executor",
      blocks: ["3"],
      blockedBy: ["1"],
      metadata: { files: ["src/parser.ts"], plan: "demo", gone: null },
    });
    expect(parseTask(text)).toEqual({
      id: "2",
      subject: "Port the parser",
      description: "Move it over.",
      activeForm: "Porting the parser",
      status: "in_progress",
      owner: "executor",
      blocks: ["3"],
      blockedBy: ["1"],
      run: "",
      isFinal: false,
      blockedReason: "",
      details: [
        { name: "files", text: '["src/parser.ts"]' },
        { name: "plan", text: "demo" },
      ],
    });
  });

  test("leaves out a task Claude Code keeps out of its own list", () => {
    expect(parseTask(stored({ metadata: { _internal: true } }))).toBeUndefined();
  });

  test("refuses a file that is not a task", () => {
    expect(parseTask("not json")).toBeUndefined();
    expect(parseTask("[]")).toBeUndefined();
    expect(parseTask(JSON.stringify({ id: 2, subject: "x", status: "pending" }))).toBeUndefined();
    expect(parseTask(stored({ status: "deleted" }))).toBeUndefined();
  });

  test("drops control characters a model wrote into the text", () => {
    expect(parseTask(stored({ subject: "Port\u001b[31m the parser" }))?.subject).toBe("Port[31m the parser");
  });
});

describe("taskListDir", () => {
  test("cuts an id to the characters Claude Code allows", () => {
    expect(taskListDir("linux", "/home/u/.claude", "my plan/1")).toBe("/home/u/.claude/tasks/my-plan-1");
    expect(taskListDir("linux", "/home/u/.claude", "my-plan_1")).toBe("/home/u/.claude/tasks/my-plan_1");
  });
});

describe("withHistory", () => {
  test("keeps finished tasks once Claude Code has deleted the list, in id order", () => {
    const seen = [task("10", "completed"), task("2", "completed")];
    expect(withHistory(seen, []).map((each) => each.id)).toEqual(["2", "10"]);
    expect(withHistory(seen, [task("11", "pending")]).map((each) => each.id)).toEqual(["2", "10", "11"]);
  });

  test("drops an open task that left the list", () => {
    expect(withHistory([task("1", "in_progress"), task("2", "pending")], [task("2", "pending")]).map((each) => each.id)).toEqual(["2"]);
  });

  test("the read wins over the earlier state of a task", () => {
    expect(withHistory([task("1", "completed")], [task("1", "in_progress")])).toEqual([task("1", "in_progress")]);
  });

  test("forgets a finished task deleted on purpose", () => {
    expect(withHistory([task("1", "completed"), task("2", "completed")], [], "1").map((each) => each.id)).toEqual(["2"]);
  });
});

describe("groupTasks", () => {
  test("orders the work and leaves out empty groups", () => {
    const tasks = [task("1", "completed"), task("2", "in_progress"), task("3", "pending", ["2"]), task("4", "pending"), task("5", "pending", ["1"])];
    expect(groupTasks(tasks).map((group) => [group.name, group.tasks.map((each) => each.id)])).toEqual([
      ["Running", ["2"]],
      ["Ready", ["4", "5"]],
      ["Waiting", ["3"]],
      ["Done", ["1"]],
    ]);
    expect(groupTasks([task("1", "pending")]).map((group) => group.name)).toEqual(["Ready"]);
    expect(groupTasks([])).toEqual([]);
  });

  test("a blocker that left the list or finished no longer holds a task back", () => {
    const tasks = [task("1", "completed"), task("3", "pending", ["1", "9"]), task("4", "pending", ["3"])];
    expect(openBlockers(tasks[1] as NativeTask, tasks)).toEqual([]);
    expect(openBlockers(tasks[2] as NativeTask, tasks)).toEqual(["3"]);
  });
});

describe("a run", () => {
  const planned = (id: string, status: NativeTask["status"], fields: Partial<NativeTask> = {}): NativeTask => ({ ...task(id, status), run: "demo", ...fields });

  test("parseTask reads the run, the final mark and the blocked reason, and keeps them out of the details", () => {
    const parsed = parseTask(stored({ metadata: { run: "demo", final: true, blocked: "no board", risk: "low" } }));
    expect(parsed).toMatchObject({ run: "demo", isFinal: true, blockedReason: "no board", details: [{ name: "risk", text: "low" }] });
  });

  test("a task given up on is closed, holds nothing back and shows under Blocked whatever its status", () => {
    const gaveUp = planned("1", "pending", { blockedReason: "no board" });
    const running = planned("3", "in_progress", { blockedReason: "vendor down" });
    const final = planned("2", "pending", { blockedBy: ["1"], isFinal: true });
    expect(isOpen(gaveUp)).toBe(false);
    expect(openBlockers(final, [gaveUp, final])).toEqual([]);
    expect(groupTasks([gaveUp, final, running]).map((group) => [group.name, group.tasks.map((each) => each.id)])).toEqual([
      ["Ready", ["2"]],
      ["Blocked", ["1", "3"]],
    ]);
  });

  test("a final task is last in its group", () => {
    const final = planned("1", "pending", { isFinal: true });
    expect(groupTasks([final, planned("2", "pending"), planned("3", "pending")]).map((group) => group.tasks.map((each) => each.id))).toEqual([["2", "3", "1"]]);
  });

  test("runState names what is open and what can go next, and ignores tasks outside a run", () => {
    const tasks = [task("1", "pending"), planned("2", "completed"), planned("3", "pending", { blockedBy: ["4"] }), planned("4", "in_progress"), planned("5", "pending", { blockedReason: "no board" })];
    const state = runState(tasks);
    expect(state?.name).toBe("demo");
    expect(state?.open.map((each) => each.id)).toEqual(["3", "4"]);
    expect(state?.next?.id).toBe("4");
    expect(state?.blocked.map((each) => each.id)).toEqual(["5"]);
    expect(runState([task("1", "pending")])).toBeUndefined();
  });

  test("taskListIdFor is stable per checkout and safe as a directory name", () => {
    expect(taskListIdFor("/work/my app")).toMatch(/^omca-my-app-[0-9a-f]{8}$/);
    expect(taskListIdFor("/work/my app")).toBe(taskListIdFor("/work/my app"));
    expect(taskListIdFor("/other/my app")).not.toBe(taskListIdFor("/work/my app"));
    expect(taskListIdFor("C:\\work\\app")).toMatch(/^omca-app-/);
  });

  test("taskListIdFor names one list for every spelling of a root, and keeps a POSIX root's id", () => {
    expect(taskListIdFor("C:\\a\\b")).toBe(taskListIdFor("c:/a/b/"));
    expect(taskListIdFor("C:\\a\\b")).not.toBe(taskListIdFor("D:\\a\\b"));
    expect(taskListIdFor("/")).toBe("omca-project-8a5edab2");
    expect(taskListIdFor("/home/utsav/dev/softs/oh-my-claudeagent")).toBe("omca-oh-my-claudeagent-d9bdbc9d");
  });
});
