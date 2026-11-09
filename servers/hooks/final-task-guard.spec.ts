import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "./registry.ts";
import { ledgerPath } from "./status-file.ts";

const NOW = 1_786_000_000_000;
const SESSION = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
const configDir = process.env.CLAUDE_CONFIG_DIR;
const disabled = process.env.OMCA_DISABLED_HOOKS;
let root: string;

beforeEach(() => {
  const config = mkdtempSync(join(tmpdir(), "omca-final-guard-config-"));
  root = mkdtempSync(join(tmpdir(), "omca-final-guard-"));
  roots.push(config, root);
  process.env.CLAUDE_CONFIG_DIR = config;
  delete process.env.OMCA_DISABLED_HOOKS;
  mkdirSync(join(root, ".omca", "state", "mod"), { recursive: true });
  writeFileSync(join(root, ".omca", "state", "mod", `${SESSION}.json`), JSON.stringify({ written_at: NOW, task_list: "demo-list" }));
  const list = join(config, "tasks", "demo-list");
  mkdirSync(list, { recursive: true });
  const base = { description: "", status: "pending", blocks: [], blockedBy: [] };
  writeFileSync(join(list, "1.json"), JSON.stringify({ ...base, id: "1", subject: "Do the work", metadata: { run: "demo" } }));
  writeFileSync(join(list, "2.json"), JSON.stringify({ ...base, id: "2", subject: "Final verification", blockedBy: ["1"], metadata: { run: "demo", final: true } }));
});

afterEach(() => {
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir;
  if (disabled === undefined) delete process.env.OMCA_DISABLED_HOOKS;
  else process.env.OMCA_DISABLED_HOOKS = disabled;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const update = (input: Record<string, unknown>) => dispatch({ event: "PreToolUse", session_id: SESSION, tool_name: "TaskUpdate", tool_input: input }, root, NOW);
const isDenied = (output: unknown): boolean => JSON.stringify(output).includes('"permissionDecision":"deny"');

function logVerdict(exitCode: number, taskId: string, stamp: Record<string, string> = { run: "demo", task_list: "demo-list" }): void {
  const path = ledgerPath(root);
  mkdirSync(join(root, ".omca", "evidence"), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, entries: [{ type: "final_verification", command: "review", exit_code: exitCode, output_snippet: "verdict", timestamp: "2026-10-02T12:05:00Z", task_id: taskId, ...stamp }] }));
}

describe("the final task", () => {
  test.each([
    ["deleted", { taskId: "2", status: "deleted" }],
    ["marked blocked", { taskId: "2", metadata: { blocked: "out of time" } }],
  ])("cannot be %s without a verdict, and the reason names the exact call", async (_name, input) => {
    const output = await update(input);
    expect(isDenied(output)).toBe(true);
    expect(JSON.stringify(output)).toContain('task_id=\\"2\\"');
  });

  test("can be abandoned once a verdict of any outcome names it", async () => {
    logVerdict(1, "2");
    expect(isDenied(await update({ taskId: "2", metadata: { blocked: "out of time" } }))).toBe(false);
    expect(isDenied(await update({ taskId: "2", status: "deleted" }))).toBe(false);
  });

  test("a verdict for another task does not count", async () => {
    logVerdict(0, "9");
    expect(isDenied(await update({ taskId: "2", status: "deleted" }))).toBe(true);
  });

  test("a verdict for the same id on another list or in another run does not count", async () => {
    logVerdict(0, "2", { run: "demo", task_list: ".omca/state/tasks" });
    expect(isDenied(await update({ taskId: "2", status: "deleted" }))).toBe(true);
    logVerdict(0, "2", { run: "other", task_list: "demo-list" });
    expect(isDenied(await update({ taskId: "2", status: "deleted" }))).toBe(true);
  });

  test.each(["final-verification", "final-task-guard"])("%s in OMCA_DISABLED_HOOKS turns the guard off", async (name) => {
    process.env.OMCA_DISABLED_HOOKS = name;
    expect(isDenied(await update({ taskId: "2", status: "deleted" }))).toBe(false);
  });

  test("a numeric taskId names the task", async () => {
    expect(isDenied(await update({ taskId: 2, status: "deleted" }))).toBe(true);
    expect(isDenied(await update({ taskId: 1, status: "deleted" }))).toBe(false);
  });

  test("a ledger the reader refuses is reported as invalid, not as a missing verdict", async () => {
    mkdirSync(join(root, ".omca", "evidence"), { recursive: true });
    writeFileSync(ledgerPath(root), "{not json");
    const output = JSON.stringify(await update({ taskId: "2", status: "deleted" }));
    expect(output).toContain('"permissionDecision":"deny"');
    expect(output).toContain("invalid schema");
    expect(output).not.toContain("no final verification names it");
  });

  test("a ledger that cannot be read denies", async () => {
    mkdirSync(ledgerPath(root), { recursive: true });
    const output = JSON.stringify(await update({ taskId: "2", status: "deleted" }));
    expect(output).toContain('"permissionDecision":"deny"');
    expect(output).toContain("invalid schema");
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a ledger with no read permission denies", async () => {
    logVerdict(1, "2");
    chmodSync(ledgerPath(root), 0o000);
    expect(isDenied(await update({ taskId: "2", status: "deleted" }))).toBe(true);
  });
});

test("every other update passes: another task, a status change, a dependency", async () => {
  expect(isDenied(await update({ taskId: "1", status: "deleted" }))).toBe(false);
  expect(isDenied(await update({ taskId: "1", metadata: { blocked: "no board" } }))).toBe(false);
  expect(isDenied(await update({ taskId: "2", status: "in_progress" }))).toBe(false);
  expect(isDenied(await update({ taskId: "2", addBlockedBy: ["1"] }))).toBe(false);
});

test.each([[null], [false]])("unmarking the final task with final: %j is denied, with or without a verdict", async (value) => {
  expect(isDenied(await update({ taskId: "2", metadata: { final: value } }))).toBe(true);
  logVerdict(0, "2");
  expect(isDenied(await update({ taskId: "2", metadata: { final: value } }))).toBe(true);
});

test.each([[true], [1], ["yes"]])("hiding the final task with _internal: %j is denied, with or without a verdict", async (value) => {
  expect(isDenied(await update({ taskId: "2", metadata: { _internal: value } }))).toBe(true);
  logVerdict(0, "2");
  expect(isDenied(await update({ taskId: "2", metadata: { _internal: value } }))).toBe(true);
});

test("_internal on another task, and a falsy _internal on the final task, pass", async () => {
  expect(isDenied(await update({ taskId: "1", metadata: { _internal: true } }))).toBe(false);
  expect(isDenied(await update({ taskId: "2", metadata: { _internal: false } }))).toBe(false);
});

test("final: true on the final task, and any final key on another task, pass", async () => {
  expect(isDenied(await update({ taskId: "2", metadata: { final: true } }))).toBe(false);
  expect(isDenied(await update({ taskId: "1", metadata: { final: null } }))).toBe(false);
});
