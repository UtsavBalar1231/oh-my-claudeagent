#!/usr/bin/env bun
// Lists the eval task definitions under tests/evals/tasks/. Trials are run by hand, see tests/evals/README.md.
//
// Usage: bun scripts/qa/eval-tasks.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TASKS_DIR = join(import.meta.dir, "..", "..", "tests", "evals", "tasks");

export type EvalTask = { name: string; category: string };

function parseTask(file: string, text: string): EvalTask {
  const parsed: unknown = JSON.parse(text);
  const fields = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const { name, category } = fields;
  if (typeof name !== "string" || typeof category !== "string") throw new Error(`${file}: expected string name and category fields`);
  return { name, category };
}

export function listTasks(dir: string = TASKS_DIR): EvalTask[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => parseTask(file, readFileSync(join(dir, file), "utf8")));
}

export function render(tasks: readonly EvalTask[]): string[] {
  return [
    "=== oh-my-claudeagent Eval Harness ===",
    `Tasks found: ${tasks.length}`,
    ...tasks.map((task) => `  [${task.category}] ${task.name}`),
    "",
    "To run a trial, follow the isolation procedure in tests/evals/README.md.",
    "Never run a fixture with this checkout as the working directory.",
  ];
}

if (import.meta.main) console.log(render(listTasks()).join("\n"));
