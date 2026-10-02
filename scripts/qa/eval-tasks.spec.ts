import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTasks, render, TASKS_DIR } from "./eval-tasks.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omca-eval-tasks-spec-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("listTasks", () => {
  test("lists each json file by name and category in file order", () => {
    writeFileSync(join(dir, "b.json"), JSON.stringify({ name: "second", category: "search", prompt: "p" }));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ name: "first", category: "edit" }));
    writeFileSync(join(dir, "notes.txt"), "not a task");
    expect(listTasks(dir)).toEqual([
      { name: "first", category: "edit" },
      { name: "second", category: "search" },
    ]);
  });

  test("names the file whose name or category is missing", () => {
    writeFileSync(join(dir, "broken.json"), JSON.stringify({ name: "only a name" }));
    expect(() => listTasks(dir)).toThrow("broken.json: expected string name and category fields");
  });

  test("reads every shipped task definition", () => {
    const tasks = listTasks(TASKS_DIR);
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) expect(task.name.length * task.category.length).toBeGreaterThan(0);
  });
});

describe("render", () => {
  test("prints the header, one line per task and the trial notes", () => {
    expect(render([{ name: "first", category: "edit" }])).toEqual([
      "=== oh-my-claudeagent Eval Harness ===",
      "Tasks found: 1",
      "  [edit] first",
      "",
      "To run a trial, follow the isolation procedure in tests/evals/README.md.",
      "Never run a fixture with this checkout as the working directory.",
    ]);
  });
});
