import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskListIdFor } from "../../src/core/native-tasks.ts";
import { touchSession } from "../hooks/session-state.ts";
import { tools } from "./tasks.ts";

const SAVED = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TASK_LIST_ID", "CLAUDE_CODE_SESSION_ID"].map((name) => [name, process.env[name]] as const);

let project: string;
let config: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "omca-task-tools-")));
  config = realpathSync(mkdtempSync(join(tmpdir(), "omca-task-config-")));
  expect(Bun.spawnSync(["git", "init", "-q", project], { env: process.env }).exitCode).toBe(0);
  process.env.CLAUDE_CONFIG_DIR = config;
  delete process.env.CLAUDE_CODE_TASK_LIST_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(() => {
  for (const [name, value] of SAVED) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(project, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}) => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool.call({ working_directory: project, ...args });
};

function store(list: string, ...tasks: (Record<string, unknown> & { id: string })[]): void {
  const dir = join(config, "tasks", list);
  mkdirSync(dir, { recursive: true });
  for (const task of tasks) writeFileSync(join(dir, `${task.id}.json`), JSON.stringify({ subject: `Task ${task.id}`, status: "pending", ...task }));
}

const run = [
  { id: "1", subject: "Build it", status: "completed", metadata: { run: "ship" } },
  { id: "2", subject: "Stuck", metadata: { run: "ship", blocked: "no access" } },
  { id: "3", subject: "Waiting", metadata: { run: "ship" } },
  { id: "4", subject: "Final verification", description: "Review the run", blockedBy: ["1", "2", "3"], metadata: { run: "ship", final: true } },
  { id: "5", subject: "An aside", status: "in_progress" },
];

describe("task_list", () => {
  test("prints each run with the marks the client's own tools leave out", async () => {
    store(taskListIdFor(project), ...run);
    expect(await call("task_list")).toBe(
      [
        "Run ship:",
        "#1 [completed] Build it",
        "#2 [pending] Stuck [closed as blocked: no access]",
        "#3 [pending] Waiting",
        "#4 [pending] Final verification [final] [waiting on #3]",
        "In no run:",
        "#5 [in_progress] An aside",
      ].join("\n"),
    );
  });

  test("an empty list says so", async () => {
    expect(await call("task_list")).toBe("The task list is empty.");
  });

  test("reads the list the session's marker names, not the checkout's default", async () => {
    store(taskListIdFor(project), { id: "1", subject: "The default list" });
    store("named-list", { id: "1", subject: "The named list" });
    const session = "ses_task_tools";
    mkdirSync(join(project, ".omca", "state", "mod"), { recursive: true });
    writeFileSync(join(project, ".omca", "state", "mod", `${session}.json`), JSON.stringify({ written_at: 1, task_list: "named-list" }));
    touchSession(session);
    expect(await call("task_list")).toBe("In no run:\n#1 [pending] The named list");
  });
});

describe("task_get", () => {
  test("returns one task in full, with the marks and the description", async () => {
    store(taskListIdFor(project), ...run);
    expect(JSON.parse(String(await call("task_get", { taskId: "4" })))).toMatchObject({
      id: "4",
      subject: "Final verification",
      description: "Review the run",
      blockedBy: ["1", "2", "3"],
      openBlockers: ["3"],
      run: "ship",
      isFinal: true,
      blockedReason: "",
    });
  });

  test("refuses an id that is not on the list", () => {
    store(taskListIdFor(project), ...run);
    expect(() => call("task_get", { taskId: "9" })).toThrow("Task #9 is not on the list");
  });

  test("refuses a missing id", () => {
    expect(() => call("task_get")).toThrow("task_get: taskId must be a string");
  });
});
