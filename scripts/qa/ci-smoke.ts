#!/usr/bin/env bun
// The CI smoke, run on every OS the workflow covers: one headless `claude -p` session with the
// packaged plugin loaded, a scratch project, its own CLAUDE_CONFIG_DIR and a dummy token against
// the mock model. The scripted turns issue a recursive removal the mod's tool.check guard must
// deny, and the checks read the client's `--debug-file` for the omca_hook calls and the deny.
//
// On Windows the script first issues the same refusal through the PowerShell tool. Whether the
// session offers that tool is read from the stream-json init message; when it does not, the run
// says so and checks the Bash deny alone.
//
// A second session drives a run's final task through the client's own task tools: it creates the
// task, reads the client's task file at the path `taskListDir` computes, reads it back through the
// server's `task_list`, is refused completion by TaskCompleted, logs the verdict and completes it.
// Its checks are prefixed "task run:" so they can be judged apart from the guard's.
//
// Usage: bun scripts/qa/ci-smoke.ts
// Exit: 0 pass, 1 a check failed, 2 the run could not be set up.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "../../servers/io.ts";
import { taskListDir, taskListIdFor } from "../../src/core/native-tasks.ts";
import { toPlatform } from "../../src/core/path.ts";
import { isRecord } from "../../src/core/tool-input.ts";
import {
  type AccessEntry,
  CANARY,
  call,
  guardDenies,
  hookCalls,
  localhostOnly,
  parseJsonLines,
  pluginDenies,
  type Qa,
  readJsonLines,
  runClaude,
  runQa,
  say,
  startMock,
  type TraceEntry,
} from "./lib.ts";
import type { Script } from "./mock-model.ts";

const POWERSHELL_TARGET = "C:\\omca-ci-smoke-no-such-dir";

type Init = { type?: string; subtype?: string; tools?: unknown };

export function offeredTools(streamJson: string): string[] {
  const init = parseJsonLines<Init>(streamJson).find((line) => line.type === "system" && line.subtype === "init");
  return Array.isArray(init?.tools) ? init.tools.filter((tool): tool is string => typeof tool === "string") : [];
}

export function smokeScript(withPowerShell: boolean): Script {
  const bash = call("Bash", { command: `CACHE="$PWD/${CANARY}"; rm -rf "$CACHE"/`, description: "smoke command" });
  const powershell = call("PowerShell", { command: `Remove-Item -Recurse -Force ${POWERSHELL_TARGET}`, description: "smoke command" });
  return { main: [...(withPowerShell ? [powershell] : []), bash, say("done")], subagent: [] };
}

const OMCA_TOOL = "mcp__plugin_oh-my-claudeagent_omca__";
const RUN = "ci-smoke-run";
const FINAL_SUBJECT = "Review the smoke run";
const TASK_ID = "1";

export function taskRunScript(taskFile: string): Script {
  const complete = call("TaskUpdate", { taskId: TASK_ID, status: "completed" });
  return {
    main: [
      call("TaskCreate", { subject: FINAL_SUBJECT, description: "Review the smoke run and record its verdict.", activeForm: "Reviewing the smoke run", metadata: { run: RUN, final: true } }),
      call("Read", { file_path: taskFile }),
      call(`${OMCA_TOOL}task_list`, {}),
      complete,
      call(`${OMCA_TOOL}evidence_log`, { evidence_type: "final_verification", command: "ci smoke task run", exit_code: 0, output_snippet: "COMPLETE", task_id: TASK_ID }),
      complete,
      say("done"),
    ],
    subagent: [],
  };
}

export type ToolResult = { name: string; text: string; isError: boolean };

const blocksOf = (line: unknown): unknown[] => {
  const message = isRecord(line) ? line.message : undefined;
  return isRecord(message) && Array.isArray(message.content) ? message.content : [];
};

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("\n") : "";

/** The main session's tool results in the order they came back, each named by the tool_use it answers. */
export function toolResults(streamJson: string): ToolResult[] {
  const blocks = parseJsonLines<unknown>(streamJson).flatMap(blocksOf).filter(isRecord);
  const names = new Map(blocks.filter((block) => block.type === "tool_use").map((block) => [block.id, block.name]));
  return blocks
    .filter((block) => block.type === "tool_result")
    .map((block) => {
      const name = names.get(block.tool_use_id);
      return { name: typeof name === "string" ? name : "", text: textOf(block.content), isError: block.is_error === true };
    });
}

async function guardSmoke({ checks, scratch }: Qa): Promise<void> {
  const onWindows = process.platform === "win32";
  const plugin = scratch.plugin();
  const project = scratch.project();
  mkdirSync(join(project, CANARY), { recursive: true });
  writeFileSync(join(project, CANARY, "stale.o"), "stale artifact\n");

  const logDir = scratch.dir("log");
  const debugPath = join(logDir, "debug.log");
  const script = smokeScript(onWindows);
  const mock = startMock(join(logDir, "access.log"), script);
  let result;
  try {
    result = await runClaude({
      cwd: project,
      prompt: "run the smoke",
      plugins: [plugin],
      port: mock.port,
      configDir: scratch.dir("config"),
      debugFile: debugPath,
      hookTrace: true,
      streamJson: true,
      env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" },
    });
  } finally {
    await mock.stop();
  }

  const debug = existsSync(debugPath) ? readFileSync(debugPath, "utf8") : "";
  const entries = readJsonLines<AccessEntry>(mock.accessLog);
  const served = entries.filter((entry) => entry.queue === "main" && entry.turn !== null).length;
  checks.check(result.code === 0, "claude -p exited 0", `claude -p exited ${result.code}: ${(result.stdout + result.stderr).trim().slice(0, 2000)}`);
  checks.check(served === script.main.length && localhostOnly(entries), `the mock served all ${served} scripted turns to localhost only`, `the mock served ${served} of ${script.main.length} scripted turns (entries ${entries.length})`);

  const trace = readJsonLines<TraceEntry>(join(project, ".omca", "state", "hook-trace.jsonl"));
  const calls = hookCalls(debug);
  checks.check(calls >= 1 && trace.length >= 1, `omca_hook was called ${calls} times by the client and traced ${trace.length} times by the server`, `omca_hook calls: ${calls} in the debug log, ${trace.length} in the server trace`);

  const bashDenies = guardDenies(debug, "Bash");
  checks.check(bashDenies.length === 1, "the mod's tool.check guard denied the Bash recursive removal once", `expected one tool.check Bash deny, saw ${JSON.stringify(bashDenies)}`);
  checks.check(existsSync(join(project, CANARY, "stale.o")), `${CANARY}/stale.o survived the denied command`, `${CANARY}/stale.o was removed despite the deny`);

  const powershellOffered = offeredTools(result.stdout).includes("PowerShell");
  if (onWindows && powershellOffered) {
    const denies = guardDenies(debug, "PowerShell");
    checks.check(denies.length === 1, "the mod's tool.check guard denied the PowerShell Remove-Item -Recurse once", `expected one tool.check PowerShell deny, saw ${JSON.stringify(denies)}`);
  } else if (onWindows) {
    checks.log(`NOTE: the session did not offer the PowerShell tool (tools: ${offeredTools(result.stdout).join(", ") || "none listed"}), so only the Bash deny was checked`);
  }
  const expectedDenies = 1 + (onWindows && powershellOffered ? 1 : 0);
  checks.check(pluginDenies(debug).length === expectedDenies, `the plugin denied ${expectedDenies} command(s) and nothing else`, `the plugin denied ${pluginDenies(debug).length} commands, expected ${expectedDenies}`);
}

async function taskRunSmoke({ checks, scratch }: Qa): Promise<void> {
  const plugin = scratch.plugin();
  const project = scratch.project();
  const configDir = scratch.dir("config");
  const listId = taskListIdFor(projectRoot(realpathSync(project)));
  const listDir = taskListDir(toPlatform(process.platform), configDir, listId);
  const taskFile = join(listDir, `${TASK_ID}.json`);
  const sessionId = crypto.randomUUID();

  const logDir = scratch.dir("log");
  const script = taskRunScript(taskFile);
  const mock = startMock(join(logDir, "access.log"), script);
  let result;
  try {
    result = await runClaude({ cwd: project, prompt: "run the task smoke", plugins: [plugin], port: mock.port, configDir, sessionId, hookTrace: true, streamJson: true });
  } finally {
    await mock.stop();
  }

  const entries = readJsonLines<AccessEntry>(mock.accessLog);
  const served = entries.filter((entry) => entry.queue === "main" && entry.turn !== null).length;
  checks.check(result.code === 0, "task run: claude -p exited 0", `task run: claude -p exited ${result.code}: ${(result.stdout + result.stderr).trim().slice(0, 2000)}`);
  checks.check(served === script.main.length && localhostOnly(entries), `task run: the mock served all ${served} scripted turns to localhost only`, `task run: the mock served ${served} of ${script.main.length} scripted turns (entries ${entries.length})`);

  const results = toolResults(result.stdout);
  const named = (name: string): ToolResult[] => results.filter((entry) => entry.name === name);
  const shown = (list: ToolResult[]): string => JSON.stringify(list).slice(0, 2000);

  const created = named("TaskCreate");
  checks.check(created.length === 1 && !created[0]?.isError && created[0]?.text.includes(`Task #${TASK_ID} created`) === true, `task run: TaskCreate made task #${TASK_ID}`, `task run: TaskCreate did not make task #${TASK_ID}: ${shown(created)}`);

  const read = named("Read");
  checks.check(read.length === 1 && !read[0]?.isError && read[0]?.text.includes(FINAL_SUBJECT) === true, `task run: the client's task file was found under ${listDir}`, `task run: no task file at ${taskFile}: ${shown(read)}`);

  const markerPath = join(project, ".omca", "state", "mod", `${sessionId}.json`);
  const marker: unknown = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : undefined;
  const markedList = isRecord(marker) ? marker.task_list : undefined;
  checks.check(markedList === listId, `task run: the mod marker's task_list is ${listId}, the id taskListIdFor gives the server's root`, `task run: the mod marker's task_list is ${JSON.stringify(markedList)}, taskListIdFor gives ${listId} (marker ${markerPath})`);

  const listed = named(`${OMCA_TOOL}task_list`);
  const lines = listed[0]?.text.split(/\r?\n/) ?? [];
  checks.check(
    listed.length === 1 && !listed[0]?.isError && lines.includes(`Run ${RUN}:`) && lines.includes(`#${TASK_ID} [pending] ${FINAL_SUBJECT} [final]`),
    `task run: task_list names run ${RUN} and marks task #${TASK_ID} [final]`,
    `task run: task_list did not show the run and its final task: ${shown(listed)}`,
  );

  const updates = named("TaskUpdate");
  const refusal = `Task #${TASK_ID} '${FINAL_SUBJECT}' is the final task of run '${RUN}', and no passing final verification names it.`;
  const completions = readJsonLines<TraceEntry>(join(project, ".omca", "state", "hook-trace.jsonl"))
    .filter((entry) => entry.event === "TaskCompleted")
    .map((entry) => entry.output);
  checks.check(
    updates[0]?.text.includes(refusal) === true && completions[0] === "block",
    "task run: TaskCompleted refused the first completion until a final verification named the task",
    `task run: the first completion was not refused (TaskCompleted traced ${JSON.stringify(completions)}): ${shown(updates)}`,
  );
  checks.check(
    updates.length === 2 && completions.length === 2 && completions[1] !== "block" && updates[1]?.isError === false && !updates[1].text.startsWith("TaskCompleted hook feedback:"),
    "task run: the second completion succeeded after the verdict was logged",
    `task run: the second completion did not succeed (TaskCompleted traced ${JSON.stringify(completions)}): ${shown(updates)}`,
  );
}

if (import.meta.main) {
  await runQa(
    "ci-smoke",
    async (qa) => {
      await guardSmoke(qa);
      await taskRunSmoke(qa);
    },
    { watchRealConfig: true },
  );
}
