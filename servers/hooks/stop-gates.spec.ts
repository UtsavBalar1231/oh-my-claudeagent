import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskListIdFor } from "../../src/core/native-tasks.ts";
import type { StopGate } from "../../src/core/stop-ledger.ts";
import { dispatch, type Output, payloadOf } from "./registry.ts";
import { findSession, touchSession } from "./session-state.ts";

const NOW = 1_786_000_000_000;
const NOW_S = NOW / 1000;
const SECOND = 1000;
const HOOKS = join(import.meta.dir, "..", "..", "hooks", "hooks.json");
const GATES: readonly StopGate[] = ["task-continuation", "drift-guard"];
const UNFINISHED = "TODO: imple" + "ment";
const CLAIM = "All done, implemented and fixed.";

const RUNNING_SUBAGENT = [{ id: "task-001", type: "subagent", status: "running", description: "executor wave", agent_type: "oh-my-claudeagent:executor" }];
const FINISHED_SUBAGENT = [{ ...RUNNING_SUBAGENT[0], status: "completed" }];

const feedback = (additionalContext: string): Output => ({ hookSpecificOutput: { hookEventName: "Stop", additionalContext } });

const continueText = (run: string, count: string, next: string): string =>
  `[TASK CONTINUATION] Run '${run}' still has ${count} (next: ${next}). Continue with the next task. ` +
  "If its work is already done and reviewed, complete it with TaskUpdate. If it cannot proceed, close it as blocked with TaskUpdate metadata " +
  '{"blocked": "<why>"}, or ask the user; a turn that asks the user is not blocked.';
const CONTINUE: Output = feedback(continueText("test-run", "1 open task", "#2 Second task not done"));

const drift = (...findings: string[]): Output =>
  feedback(
    `[DRIFT GUARD] Completion claimed but stub markers remain on added/untracked lines:\n${findings.map((line) => `${line}\n`).join("")}\n` +
      "Resolve the stubs before claiming done, or stop claiming completion. Set OMCA_DISABLED_HOOKS=drift-guard to bypass.",
  );

const roots: string[] = [];
const configDir = process.env.CLAUDE_CONFIG_DIR;
let config: string;

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "omca-stop-gates-config-"));
  roots.push(config);
  process.env.CLAUDE_CONFIG_DIR = config;
});

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const onlyGate = (gate: StopGate): void => {
  process.env.OMCA_DISABLED_HOOKS = GATES.filter((other) => other !== gate).join(",");
};

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-stop-gates-"));
  roots.push(root);
  mkdirSync(join(root, ".omca", "state"), { recursive: true });
  return root;
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, env: process.env, stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function repository(): string {
  const root = project();
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  return root;
}

function commitAll(root: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-qm", "seed");
}

function write(root: string, file: string, content: string | Uint8Array): void {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), content);
}

const append = (root: string, file: string, content: string): void => write(root, file, readFileSync(join(root, file), "utf8") + content);

type Stop = { root: string; sessionId: string; stop: (extra?: Record<string, unknown>, now?: number) => Promise<Output> };

function session(root = project(), sessionId: string = crypto.randomUUID()): Stop {
  mkdirSync(join(root, ".omca", "state", "mod"), { recursive: true });
  writeFileSync(join(root, ".omca", "state", "mod", `${sessionId}.json`), JSON.stringify({ written_at: NOW, task_list: sessionId }));
  return {
    root,
    sessionId,
    stop: (extra = {}, now = NOW) => dispatch({ event: "Stop", session_id: sessionId, stop_hook_active: "false", ...extra }, root, now),
  };
}

type Task = Record<string, unknown> & { id: string };

const task = (id: string, subject: string, fields: Record<string, unknown> = {}): Task => ({
  id,
  subject,
  description: "",
  status: "pending",
  blocks: [],
  blockedBy: [],
  metadata: { run: "test-run" },
  ...fields,
});

const FIRST_DONE = task("1", "First task", { status: "completed" });
const SECOND_OPEN = task("2", "Second task not done");

function writeTasks(listId: string, ...tasks: readonly Task[]): void {
  const dir = join(config, "tasks", listId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const entry of tasks) writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(entry));
}

const touch = (run: Stop, status = "in_progress", tool = "TaskUpdate"): Promise<Output> =>
  dispatch({ event: "PostToolUse", session_id: run.sessionId, tool_name: tool, tool_input: { status } }, run.root, NOW);

async function pickedUp(...tasks: readonly Task[]): Promise<Stop> {
  const run = session();
  writeTasks(run.sessionId, ...tasks);
  await touch(run);
  return run;
}

const openRun = (): Promise<Stop> => pickedUp(FIRST_DONE, SECOND_OPEN);

function transcript(root: string, ...records: object[]): string {
  const path = join(root, "transcript.jsonl");
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return path;
}

const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
const assistant = (content: unknown) => ({ type: "assistant", message: { role: "assistant", content } });
const said = (text: string) => assistant([{ type: "text", text }]);

const ASKED = [
  user("work through the run"),
  said("Task 2 forks two ways."),
  assistant([{ type: "tool_use", name: "AskUserQuestion", input: {} }]),
  user([{ type: "tool_result", content: "recursive descent" }]),
];

async function stops(run: Stop, times: number, extra: Record<string, unknown> = {}): Promise<Output[]> {
  const answers: Output[] = [];
  for (let i = 0; i < times; i++) answers.push(await run.stop(extra));
  return answers;
}

const quietErrors = () => spyOn(console, "error").mockImplementation(() => {});

describe("task continuation: who answers for a run", () => {
  beforeEach(() => onlyGate("task-continuation"));

  test("a session that never touched a task is not held, whatever the list holds", async () => {
    const run = session();
    writeTasks(run.sessionId, FIRST_DONE, SECOND_OPEN);
    expect(await run.stop()).toEqual({});
    expect(findSession(run.sessionId)?.runBackoff).toBeUndefined();
    expect(findSession(run.sessionId)?.stopBlocks).toBeUndefined();
  });

  test.each(["in_progress", "completed"])("TaskUpdate to %s picks the run up, and the next stop continues it", async (status) => {
    const run = session();
    writeTasks(run.sessionId, FIRST_DONE, SECOND_OPEN);
    expect(await run.stop()).toEqual({});
    expect(await touch(run, status)).toEqual({});
    expect(await run.stop()).toEqual(CONTINUE);
  });

  test("planning does not pick the run up: creating tasks and linking them leave the session free to stop", async () => {
    const run = session();
    writeTasks(run.sessionId, FIRST_DONE, SECOND_OPEN);
    await touch(run, "", "TaskCreate");
    await touch(run, "");
    expect(await run.stop()).toEqual({});
  });

  test.each(["TaskList", "TaskGet", "Read"])("%s does not pick the run up", async (tool) => {
    const run = session();
    writeTasks(run.sessionId, FIRST_DONE, SECOND_OPEN);
    await touch(run, "in_progress", tool);
    expect(await run.stop()).toEqual({});
  });

  test("another session's touch does not hold this one", async () => {
    const run = session();
    writeTasks(run.sessionId, FIRST_DONE, SECOND_OPEN);
    await touch(session(run.root));
    expect(await run.stop()).toEqual({});
  });

  test("task-touch in OMCA_DISABLED_HOOKS leaves the session unheld", async () => {
    const run = session();
    writeTasks(run.sessionId, FIRST_DONE, SECOND_OPEN);
    process.env.OMCA_DISABLED_HOOKS = "drift-guard,task-touch";
    await touch(run);
    expect(findSession(run.sessionId)?.hasTouchedTask).toBeUndefined();
    expect(await run.stop()).toEqual({});
  });

  test("a session whose blocks cannot be recorded never blocks", async () => {
    const errors = quietErrors();
    try {
      const run = session(project(), "../escape");
      writeTasks("---escape", FIRST_DONE, SECOND_OPEN);
      await touch(run);
      expect(await stops(run, 10)).toEqual(Array(10).fill({}));
    } finally {
      errors.mockRestore();
    }
  });
});

describe("task continuation: the list it reads", () => {
  beforeEach(() => onlyGate("task-continuation"));

  function marked(run: Stop, marker: string): void {
    write(run.root, join(".omca", "state", "mod", `${run.sessionId}.json`), marker);
  }

  test("the mod's marker names the list", async () => {
    const run = session();
    writeTasks("omca-shared-list", FIRST_DONE, SECOND_OPEN);
    marked(run, JSON.stringify({ written_at: NOW, task_list: "omca-shared-list" }));
    await touch(run);
    expect(await run.stop()).toEqual(CONTINUE);
  });

  test("a marker that names no list falls back to the session's own", async () => {
    const run = await openRun();
    marked(run, JSON.stringify({ written_at: NOW, task_list: null }));
    expect(await run.stop()).toEqual(CONTINUE);
  });

  test("a marker that does not parse is logged and falls back to the list the mod names", async () => {
    const run = await openRun();
    marked(run, "{torn");
    writeTasks(taskListIdFor(run.root), FIRST_DONE, SECOND_OPEN);
    const errors = quietErrors();
    try {
      expect(await run.stop()).toEqual(CONTINUE);
      expect(errors.mock.calls.map(([message]) => message)).toEqual([`omca: could not read the mod marker of session ${run.sessionId}:`]);
    } finally {
      errors.mockRestore();
    }
  });

  test("a list id is cut to the characters a directory name allows, as the client does", async () => {
    const run = session();
    writeTasks("my-list-1", FIRST_DONE, SECOND_OPEN);
    marked(run, JSON.stringify({ written_at: NOW, task_list: "my/list.1" }));
    await touch(run);
    expect(await run.stop()).toEqual(CONTINUE);
  });

  test("files that are not tasks are skipped: a dotfile, a malformed file, a directory and Claude Code's internal task", async () => {
    const run = await openRun();
    const dir = join(config, "tasks", run.sessionId);
    writeFileSync(join(dir, ".lock"), "");
    writeFileSync(join(dir, ".highwatermark.json"), JSON.stringify(task("9", "Hidden")));
    writeFileSync(join(dir, "3.json"), "{not json");
    writeFileSync(join(dir, "4.json"), JSON.stringify({ id: "4" }));
    writeFileSync(join(dir, "5.json"), JSON.stringify(task("5", "Internal", { metadata: { run: "test-run", _internal: true } })));
    mkdirSync(join(dir, "6.json"));
    expect(await run.stop()).toEqual(CONTINUE);
  });
});

describe("task continuation: what it says", () => {
  beforeEach(() => onlyGate("task-continuation"));

  test("an open task continues with the exact text and spends one block", async () => {
    const run = await openRun();
    expect(await run.stop()).toEqual(CONTINUE);
    const state = findSession(run.sessionId);
    expect(state?.runBackoff).toEqual({ run: "test-run", backoff: { consecutiveBlocks: 1, lastBlockAt: NOW_S, lastOpen: 1, sameCountRun: 1, isStagnated: false } });
    expect([...(state?.stopBlocks ?? [])]).toEqual([["task-continuation", 1]]);
  });

  test("several open tasks are counted, and the next is the first nothing holds back", async () => {
    const run = await pickedUp(task("1", "First", { blockedBy: ["3"] }), task("2", "Second"), task("3", "Third", { status: "in_progress" }));
    expect(await run.stop()).toEqual(feedback(continueText("test-run", "3 open tasks", "#2 Second")));
  });

  test("the next task follows numeric id order, not the order the directory lists them", async () => {
    const run = await pickedUp(task("10", "Tenth"), task("2", "Second"));
    expect(await run.stop()).toEqual(feedback(continueText("test-run", "2 open tasks", "#2 Second")));
  });

  test("a task closed as blocked is neither counted nor the next, and no longer holds another back", async () => {
    const run = await pickedUp(task("1", "First", { metadata: { run: "test-run", blocked: "no credentials" } }), task("2", "Second task not done", { blockedBy: ["1"] }));
    expect(await run.stop()).toEqual(CONTINUE);
  });

  test("when every open task waits on another, the first of them is named", async () => {
    const run = await pickedUp(task("1", "First", { blockedBy: ["2"] }), task("2", "Second", { blockedBy: ["1"] }));
    expect(await run.stop()).toEqual(feedback(continueText("test-run", "2 open tasks", "#1 First")));
  });

  test("a run's name is the first open task's, and another run's tasks are not counted", async () => {
    const run = await pickedUp(task("1", "Old", { status: "completed", metadata: { run: "old-run" } }), task("2", "New", { metadata: { run: "new-run" } }), task("3", "Later", { metadata: { run: "later-run" } }));
    expect(await run.stop()).toEqual(feedback(continueText("new-run", "1 open task", "#2 New")));
  });
});

describe("task continuation: when it stops", () => {
  beforeEach(() => onlyGate("task-continuation"));

  test("tasks with no run are ignored", async () => {
    const run = await pickedUp(task("1", "Ad hoc", { metadata: {} }), task("2", "No metadata", { metadata: undefined }));
    expect(await run.stop()).toEqual({});
  });

  test("a task with no run beside a planned one is not counted", async () => {
    const run = await pickedUp(FIRST_DONE, task("3", "Ad hoc", { metadata: {} }), SECOND_OPEN);
    expect(await run.stop()).toEqual(CONTINUE);
  });

  test("a run with every task completed allows Stop, and no final verification is asked for here", async () => {
    const run = await pickedUp(FIRST_DONE, task("2", "Final", { status: "completed", metadata: { run: "test-run", final: true } }));
    expect(await run.stop()).toEqual({});
  });

  test("a run with only completed and blocked tasks allows Stop", async () => {
    const run = await pickedUp(FIRST_DONE, task("2", "Second", { metadata: { run: "test-run", blocked: "no credentials" } }));
    expect(await run.stop()).toEqual({});
  });

  test("a list the client already deleted allows Stop", async () => {
    const run = await openRun();
    rmSync(join(config, "tasks", run.sessionId), { recursive: true, force: true });
    expect(await run.stop()).toEqual({});
  });

  test("once nothing is open the budget comes back and the backoff clears", async () => {
    const run = await openRun();
    expect(await run.stop()).toEqual(CONTINUE);
    writeTasks(run.sessionId, FIRST_DONE, { ...SECOND_OPEN, status: "completed" });
    expect(await run.stop({}, NOW + 10 * SECOND)).toEqual({});
    expect(findSession(run.sessionId)?.runBackoff).toBeUndefined();
    expect(findSession(run.sessionId)?.stopBlocks?.has("task-continuation")).toBe(false);
  });

  test("stop_hook_active allows Stop and leaves the counters untouched", async () => {
    const run = await openRun();
    expect(await run.stop({ stop_hook_active: "true" })).toEqual({});
    expect(findSession(run.sessionId)?.runBackoff).toBeUndefined();
    expect(findSession(run.sessionId)?.stopBlocks).toBeUndefined();
  });

  test("OMCA_DISABLED_HOOKS=task-continuation allows Stop", async () => {
    const run = await openRun();
    process.env.OMCA_DISABLED_HOOKS = "drift-guard,task-continuation";
    expect(await run.stop()).toEqual({});
  });

  test("cooldown suppresses a second rapid invocation", async () => {
    const run = await openRun();
    expect(await run.stop()).toEqual(CONTINUE);
    expect(await run.stop({}, NOW + 9 * SECOND)).toEqual({});
    expect(await run.stop({}, NOW + 10 * SECOND)).toEqual(CONTINUE);
    expect(findSession(run.sessionId)?.runBackoff).toEqual({ run: "test-run", backoff: { consecutiveBlocks: 2, lastBlockAt: NOW_S + 10, lastOpen: 1, sameCountRun: 2, isStagnated: false } });
  });

  test("stagnation escape frees the 4th identical-count invocation", async () => {
    const run = await openRun();
    for (const at of [0, 100, 200]) expect(await run.stop({}, NOW + at * SECOND)).toEqual(CONTINUE);
    expect(await run.stop({}, NOW + 300 * SECOND)).toEqual({});
    expect(findSession(run.sessionId)?.runBackoff).toEqual({ run: "test-run", backoff: { consecutiveBlocks: 3, lastBlockAt: NOW_S + 200, lastOpen: 1, sameCountRun: 3, isStagnated: true } });
    expect(await run.stop({}, NOW + 10_000 * SECOND)).toEqual({});
  });

  test("a run that stagnated does not hold back the next run", async () => {
    const run = await openRun();
    for (const at of [0, 100, 200]) expect(await run.stop({}, NOW + at * SECOND)).toEqual(CONTINUE);
    expect(await run.stop({}, NOW + 300 * SECOND)).toEqual({});
    writeTasks(run.sessionId, task("2", "Second task not done", { metadata: { run: "run-b" } }));
    expect(await run.stop({}, NOW + 301 * SECOND)).toEqual(feedback(continueText("run-b", "1 open task", "#2 Second task not done")));
    expect(findSession(run.sessionId)?.runBackoff?.run).toBe("run-b");
  });

  test("a user pause in the transcript allows Stop", async () => {
    const run = await openRun();
    const path = transcript(run.root, user("start on task 2"), said("Working on it."), user("let's pause here for now"));
    expect(await run.stop({ transcript_path: path })).toEqual({});
  });

  test.each(["keep going", "do task 2 later", "pause the music in the demo, then continue"])("a last prompt that is not a pause request (%p) still blocks", async (prompt) => {
    const run = await openRun();
    const path = transcript(run.root, user("start on task 2"), said("Working on it."), user(prompt));
    expect(await run.stop({ transcript_path: path })).toEqual(CONTINUE);
  });

  test.each(["later", "ok, stop here.", "Great work. Let's continue tomorrow", "can we take a break?"])("a last prompt that asks to pause (%p) allows Stop", async (prompt) => {
    const run = await openRun();
    const path = transcript(run.root, user("start on task 2"), said("Working on it."), user(prompt));
    expect(await run.stop({ transcript_path: path })).toEqual({});
  });

  test("only the transcript's last 2 MiB is read, and a prompt before it counts for nothing", async () => {
    const run = await openRun();
    const filler = said("x".repeat(1024));
    const path = transcript(run.root, user("lets pause here"), ...Array.from({ length: 2100 }, () => filler));
    expect(await run.stop({ transcript_path: path })).toEqual(CONTINUE);
    const tail = transcript(run.root, ...Array.from({ length: 2100 }, () => filler), user("lets pause here"));
    expect(await run.stop({ transcript_path: tail }, NOW + 10 * SECOND)).toEqual({});
  });

  test("the scan reads past a tool_result-only user entry to the pause prompt", async () => {
    const run = await openRun();
    const path = transcript(
      run.root,
      user("start on task 2"),
      said("Working on it."),
      user("lets pause here for now."),
      assistant([{ type: "tool_use", name: "Read", input: {} }]),
      user([{ type: "tool_result", content: "file contents" }]),
    );
    expect(await run.stop({ transcript_path: path })).toEqual({});
  });

  test("malformed lines after the pause prompt are skipped, not read as a prompt", async () => {
    const run = await openRun();
    const path = transcript(run.root, user("start on task 2"), said("Working on it."), user("lets pause here for now."));
    writeFileSync(path, `${readFileSync(path, "utf8")}{not json\n\n[1, 2]\n"text"\n`);
    expect(await run.stop({ transcript_path: path })).toEqual({});
  });

  test("an AskUserQuestion call in this turn allows Stop", async () => {
    const run = await openRun();
    expect(await run.stop({ transcript_path: transcript(run.root, ...ASKED), last_assistant_message: "Task 2 forks two ways." })).toEqual({});
  });

  test("an AskUserQuestion call before a later user prompt still blocks", async () => {
    const run = await openRun();
    const path = transcript(run.root, ...ASKED, user("go with recursive descent"), said("Understood."));
    expect(await run.stop({ transcript_path: path, last_assistant_message: "Understood." })).toEqual(CONTINUE);
  });

  test("an unreadable transcript record after the call yields no escape", async () => {
    const run = await openRun();
    const path = transcript(run.root, ...ASKED);
    writeFileSync(path, `${readFileSync(path, "utf8")}{not json\n`);
    expect(await run.stop({ transcript_path: path, last_assistant_message: "Task 2 forks two ways." })).toEqual(CONTINUE);
  });

  test("no marker and no AskUserQuestion call blocks", async () => {
    const run = await openRun();
    const path = transcript(
      run.root,
      user("work through the run"),
      assistant([{ type: "tool_use", name: "Read", input: {} }]),
      user([{ type: "tool_result", content: "file body" }]),
    );
    expect(await run.stop({ transcript_path: path, last_assistant_message: "Read the file, moving on." })).toEqual(CONTINUE);
  });

  test("a prose question with no marker and no tool call blocks", async () => {
    const run = await openRun();
    const question = "Which parser should task 2 use, recursive descent or generated?";
    const path = transcript(run.root, user("work through the run"), said(question));
    expect(await run.stop({ transcript_path: path, last_assistant_message: question })).toEqual(CONTINUE);
  });

  test("a declared BLOCKING QUESTIONS block allows Stop", async () => {
    const run = await openRun();
    const message = "Task 2 needs a decision.\n\n## BLOCKING QUESTIONS\n\nQ1. Which parser?\nA) recursive descent\nB) generated\nRecommended: A";
    expect(await run.stop({ last_assistant_message: message })).toEqual({});
  });

  test("the BLOCKING QUESTIONS heading is read from the transcript when the payload has no message", async () => {
    const run = await openRun();
    const path = transcript(run.root, user("go"), said("Stuck.\n### BLOCKING QUESTIONS\nQ1. Which?"));
    expect(await run.stop({ transcript_path: path })).toEqual({});
  });

  test("a trailing question mark is not an escape and still blocks", async () => {
    const run = await openRun();
    expect(await run.stop({ last_assistant_message: "Should I refactor the parser first?" })).toEqual(CONTINUE);
  });

  test("a compaction in the last minute allows Stop", async () => {
    const run = await openRun();
    const compact = (at: number) => dispatch({ event: "SessionStart", session_id: run.sessionId, cwd: run.root, source: "compact" }, run.root, at);
    await compact(NOW - 59 * SECOND);
    expect(await run.stop()).toEqual({});
    await compact(NOW - 60 * SECOND);
    expect(await run.stop()).toEqual(CONTINUE);
  });
});

describe("task continuation and background work", () => {
  beforeEach(() => onlyGate("task-continuation"));

  test("blocks when tasks remain and nothing is running", async () => {
    const run = await openRun();
    expect(await run.stop({ background_tasks: [] })).toEqual(CONTINUE);
  });

  test("opens when a background task is running", async () => {
    const run = await openRun();
    const payload = payloadOf({ event: "Stop", session_id: run.sessionId, stop_hook_active: "false", background_tasks: JSON.stringify(RUNNING_SUBAGENT) });
    expect(await dispatch(payload, run.root, NOW)).toEqual({});
    expect(findSession(run.sessionId)?.runBackoff).toBeUndefined();
  });

  test("a running background shell, such as a dev server, still blocks", async () => {
    const run = await openRun();
    const shell = [{ id: "task-002", type: "shell", status: "running", description: "bun run dev" }];
    expect(await run.stop({ background_tasks: shell })).toEqual(CONTINUE);
    expect(await run.stop({ background_tasks: [...shell, ...RUNNING_SUBAGENT] }, NOW + 10 * SECOND)).toEqual({});
  });

  test("a finished background task still blocks", async () => {
    const run = await openRun();
    expect(await run.stop({ background_tasks: FINISHED_SUBAGENT })).toEqual(CONTINUE);
  });

  test("the open path clears this gate's ledger key only", async () => {
    const run = await openRun();
    touchSession(run.sessionId).stopBlocks = new Map([
      ["task-continuation", 3],
      ["drift-guard", 2],
    ]);
    expect(await run.stop({ background_tasks: RUNNING_SUBAGENT })).toEqual({});
    expect([...(findSession(run.sessionId)?.stopBlocks ?? [])]).toEqual([["drift-guard", 2]]);
  });

  test("drift-guard: still blocks a completion claim while a task is running", async () => {
    const run = session(repository());
    write(run.root, "a.js", "seed\n");
    commitAll(run.root);
    append(run.root, "a.js", "it.only('t', () => {})\n");
    onlyGate("drift-guard");
    expect(await run.stop({ last_assistant_message: CLAIM, background_tasks: RUNNING_SUBAGENT })).toEqual(drift("a.js:2  it.only('t', () => {})"));
  });
});

describe("drift-guard", () => {
  beforeEach(() => onlyGate("drift-guard"));

  function seeded(file = "a.txt", content = "hello\n"): Stop {
    const run = session(repository());
    write(run.root, file, content);
    commitAll(run.root);
    return run;
  }

  const claim = (run: Stop, message = "Done."): Promise<Output> => run.stop({ last_assistant_message: message });

  test("drift-guard: clean repo with completion claim allows Stop", async () => {
    expect(await claim(seeded(), CLAIM)).toEqual({});
  });

  test("drift-guard: .only marker on an added line blocks Stop", async () => {
    const run = seeded("a.js");
    append(run.root, "a.js", "it.only('t', () => {})\n");
    expect(await claim(run, "Done, all tests pass.")).toEqual(drift("a.js:2  it.only('t', () => {})"));
  });

  test("drift-guard: marker on a pre-existing unchanged line allows Stop", async () => {
    const run = seeded("preexist.js", "line1\nit.only('x')\nline3\n");
    append(run.root, "preexist.js", "unrelated new line\n");
    expect(await claim(run, "Implemented and fixed.")).toEqual({});
  });

  test("drift-guard: untracked new stub file blocks Stop", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run)).toEqual(drift(`new.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: untracked binary file does not crash and is not a false block", async () => {
    const run = seeded();
    write(run.root, "bin.dat", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, ...new TextEncoder().encode(UNFINISHED)]));
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: an untracked file over 1 MiB is not scanned, and one at the limit is", async () => {
    const run = seeded();
    write(run.root, "huge.log", `${UNFINISHED}\n${"x".repeat(1024 * 1024)}`);
    expect(await claim(run)).toEqual({});
    write(run.root, "limit.log", `${UNFINISHED}\n${"x".repeat(1024 * 1024 - UNFINISHED.length - 1)}`);
    expect(await claim(run)).toEqual(drift(`limit.log:1  ${UNFINISHED}`));
  });

  test("drift-guard: non-git directory fails open (allows Stop)", async () => {
    const run = session();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: repo with no commits (no HEAD) fails open (allows Stop)", async () => {
    const run = session(repository());
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: OMCA_DISABLED_HOOKS listing this hook allows Stop", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    process.env.OMCA_DISABLED_HOOKS = "task-continuation,drift-guard";
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: OMCA_DISABLED_HOOKS listing a different hook still blocks", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    process.env.OMCA_DISABLED_HOOKS = "task-continuation,other-hook";
    expect(await claim(run)).toEqual(drift(`new.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: assistant text extracted from transcript_path when last_assistant_message is absent", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    const path = transcript(run.root, user("go"), said("Done, all fixed."), { type: "last-prompt", lastPrompt: "x" });
    expect(await run.stop({ transcript_path: path })).toEqual(drift(`new.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: a malformed line after the claim does not hide the claim read from the transcript", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    const path = transcript(run.root, user("go"), said("Done, all fixed."));
    writeFileSync(path, `${readFileSync(path, "utf8")}{not json\n`);
    expect(await run.stop({ transcript_path: path })).toEqual(drift(`new.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: no assistant text anywhere allows Stop", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await run.stop({ transcript_path: transcript(run.root, user("go")) })).toEqual({});
  });

  test("drift-guard: a quoted 'done' is not a completion claim", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run, 'You asked whether the parser is "done" — the answer is no.')).toEqual({});
  });

  test("drift-guard: an unquoted claim in the same shape still blocks", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run, "The parser is done and the answer is yes.")).toEqual(drift(`new.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: a negator earlier in the same sentence suppresses the claim", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run, "The suite is not green, so the parser path is fixed nowhere yet.")).toEqual({});
  });

  test("drift-guard: a negator in a previous sentence does not suppress a later claim", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run, "Earlier the suite was not green. The parser is fixed now.")).toEqual(drift(`new.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: negated completion claim (not done) allows Stop despite a stub", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run, "This is not done yet.")).toEqual({});
  });

  test("drift-guard: a marker inside a bats test name is not a finding", async () => {
    const run = seeded();
    write(run.root, "suite.bats", `@test "guard: ${UNFINISHED} is reported" {\n\ttrue\n}\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: a marker in a bats test body is still a finding", async () => {
    const run = seeded();
    write(run.root, "suite.bats", `@test "guard: something" {\n\t# ${UNFINISHED}\n}\n`);
    expect(await claim(run)).toEqual(drift(`suite.bats:2  # ${UNFINISHED}`));
  });

  test("drift-guard: a marker in unfenced Markdown prose is not a finding", async () => {
    const run = seeded();
    write(run.root, "doc.md", `Still to do: ${UNFINISHED} the pagination path.\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: every prose extension is skipped", async () => {
    const run = seeded();
    for (const extension of ["md", "markdown", "rst", "txt", "adoc"]) write(run.root, `notes.${extension}`, `${UNFINISHED} the parser\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: the prose carve-out does not leak to code files", async () => {
    const run = seeded();
    write(run.root, "script.sh", `# ${UNFINISHED} pagination\n`);
    expect(await claim(run)).toEqual(drift(`script.sh:1  # ${UNFINISHED} pagination`));
  });

  test("drift-guard: a marker as a shell string constant is not a finding", async () => {
    const run = seeded();
    write(run.root, "guard.sh", `MARKER_TODO='${UNFINISHED}'\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: a marker in a Python list literal outside tests/ is not a finding", async () => {
    const run = seeded();
    write(run.root, "lint_rules.py", `BANNED = ["${UNFINISHED}"]\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: an unquoted marker comment in the same file is still a finding", async () => {
    const run = seeded();
    write(run.root, "guard.sh", `MARKER_TODO='${UNFINISHED}'\n# ${UNFINISHED} the parser\n`);
    expect(await claim(run)).toEqual(drift(`guard.sh:2  # ${UNFINISHED} the parser`));
  });

  test("drift-guard: a not-implemented throw is still a finding despite its quotes", async () => {
    const run = seeded();
    const stub = 'function f() { throw new Error("not imple' + 'mented yet"); }';
    write(run.root, "impl.js", `${stub}\n`);
    expect(await claim(run)).toEqual(drift(`impl.js:1  ${stub}`));
  });

  test("drift-guard: an ORM .only() projection is not a finding", async () => {
    const run = seeded();
    write(run.root, "orm.py", "qs = Model.objects.only('id')\nrow = User.select().only(User.id)\n");
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: a focused test .only is still a finding", async () => {
    const run = seeded();
    write(run.root, "spec.js", "describe.only('suite', () => {})\n");
    expect(await claim(run)).toEqual(drift("spec.js:1  describe.only('suite', () => {})"));
  });

  test("drift-guard: an unresolved stub stops blocking once the Stop-block cap is hit", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    const block = drift(`new.sh:1  ${UNFINISHED}`);
    expect(await stops(run, 7, { last_assistant_message: "Done." })).toEqual([block, block, block, block, block, {}, {}]);
  });

  test("drift-guard: resolving the stub restores the Stop-block budget", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect((await stops(run, 6, { last_assistant_message: "Done." })).at(-1)).toEqual({});
    write(run.root, "new.sh", "resolved\n");
    expect(await claim(run)).toEqual({});
    expect(findSession(run.sessionId)?.stopBlocks?.has("drift-guard")).toBe(false);
    write(run.root, "another.sh", `${UNFINISHED}\n`);
    expect(await claim(run)).toEqual(drift(`another.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: a tree above the changed-file ceiling skips the scan", async () => {
    const run = session(repository());
    for (let i = 1; i <= 520; i++) write(run.root, `src/f${i}.sh`, "line\n");
    commitAll(run.root);
    for (let i = 1; i <= 520; i++) append(run.root, `src/f${i}.sh`, `${UNFINISHED}\n`);
    const errors = quietErrors();
    try {
      expect(await claim(run)).toEqual({});
      expect(errors.mock.calls).toEqual([["omca: drift-guard: 520 changed files exceeds the 500-file scan ceiling, so the stub scan is skipped this Stop."]]);
    } finally {
      errors.mockRestore();
    }
  });

  test("drift-guard: a tree just under the ceiling still scans and blocks", async () => {
    const run = session(repository());
    for (let i = 1; i <= 40; i++) write(run.root, `src/f${i}.sh`, "line\n");
    commitAll(run.root);
    append(run.root, "src/f7.sh", `${UNFINISHED}\n`);
    expect(await claim(run)).toEqual(drift(`src/f7.sh:2  ${UNFINISHED}`));
  });

  test("drift-guard: a marker in a file whose name contains a space is reported", async () => {
    const run = seeded();
    write(run.root, "my file.js", "it.only('t', () => {})\n");
    git(run.root, "add", "-A");
    expect(await claim(run, "Done, all tests pass.")).toEqual(drift("my file.js:1  it.only('t', () => {})"));
  });

  test("drift-guard: diff.mnemonicPrefix does not mangle the reported path", async () => {
    const run = seeded();
    git(run.root, "config", "diff.mnemonicPrefix", "true");
    write(run.root, "pager.sh", `# ${UNFINISHED} pagination\n`);
    git(run.root, "add", "-A");
    expect(await claim(run)).toEqual(drift(`pager.sh:1  # ${UNFINISHED} pagination`));
  });

  test("drift-guard: core.quotePath does not mangle a non-ASCII path", async () => {
    const run = seeded();
    git(run.root, "config", "core.quotePath", "true");
    write(run.root, "café.js", "it.only('t', () => {})\n");
    git(run.root, "add", "-A");
    expect(await claim(run)).toEqual(drift("café.js:1  it.only('t', () => {})"));
  });

  test("drift-guard: an external diff driver cannot replace the parse input", async () => {
    const run = seeded("a.js");
    git(run.root, "config", "diff.external", "true");
    append(run.root, "a.js", "it.only('t', () => {})\n");
    expect(await claim(run)).toEqual(drift("a.js:2  it.only('t', () => {})"));
  });

  test("drift-guard: specify.only, it.concurrent.only and serial.only are markers", async () => {
    const run = seeded("a.js");
    append(run.root, "a.js", "specify.only('a')\nit.concurrent.only('b')\ntest.describe.serial.only('c')\n");
    expect(await claim(run)).toEqual(drift("a.js:2  specify.only('a')", "a.js:3  it.concurrent.only('b')", "a.js:4  test.describe.serial.only('c')"));
  });

  test("drift-guard: Model.objects.only stays excluded", async () => {
    const run = seeded("a.js");
    append(run.root, "a.js", "qs = Model.objects.only('id')\n");
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: a focused-test spelling in a non-JS file is prose, not a runnable focused test", async () => {
    const run = seeded();
    write(run.root, "helper.sh", `echo "it.only(1)"\n`);
    write(run.root, "mod.py", `note = "it.only(2)"\n`);
    write(run.root, "notes.txt", `it.only("x")\n`);
    write(run.root, "suite.bats", `@test "it.only in a name" {\n\techo "it.only(3)"\n}\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: a focused test in a .ts file is still a finding", async () => {
    const run = seeded();
    write(run.root, "spec.ts", "it.only('x', () => {})\n");
    expect(await claim(run)).toEqual(drift("spec.ts:1  it.only('x', () => {})"));
  });

  test("drift-guard: an unfinished-implementation marker stays language-independent", async () => {
    const run = seeded();
    write(run.root, "helper.sh", `run() { : ; } # ${UNFINISHED}\n`);
    write(run.root, "mod.py", `def run(): pass  # ${UNFINISHED}\n`);
    write(run.root, "mod.rs", `fn run() {} // ${UNFINISHED}\n`);
    expect(await claim(run)).toEqual(
      drift(`helper.sh:1  run() { : ; } # ${UNFINISHED}`, `mod.py:1  def run(): pass  # ${UNFINISHED}`, `mod.rs:1  fn run() {} // ${UNFINISHED}`),
    );
  });

  test("drift-guard: a single-line hunk reports the file's own line number", async () => {
    const run = seeded("spec.js", "a\nb\nc\nd\ne\n");
    write(run.root, "spec.js", "a\nb\nc\nit.only('x')\ne\n");
    expect(await claim(run)).toEqual(drift("spec.js:4  it.only('x')"));
  });

  test("drift-guard: removed lines before an addition do not shift the reported line", async () => {
    const run = seeded("spec.js", "a\nb\nc\nd\ne\nf\n");
    write(run.root, "spec.js", "a\nb\nit.only('x')\nf\n");
    expect(await claim(run)).toEqual(drift("spec.js:3  it.only('x')"));
  });
});

describe("stop ledger", () => {
  async function openRepository(): Promise<Stop> {
    const run = session(repository());
    write(run.root, "a.js", "seed\n");
    commitAll(run.root);
    writeTasks(run.sessionId, FIRST_DONE, SECOND_OPEN);
    await touch(run);
    return run;
  }

  test("stop ledger: a resetting gate does not refund a blocking sibling's budget", async () => {
    const run = await openRepository();
    expect(await stops(run, 2, { last_assistant_message: CLAIM })).toEqual([CONTINUE, {}]);
    expect([...(findSession(run.sessionId)?.stopBlocks ?? [])]).toEqual([["task-continuation", 1]]);
  });

  test("stop ledger: a gate's own reset clears only its own key", async () => {
    const run = await openRepository();
    expect(await run.stop()).toEqual(CONTINUE);
    append(run.root, "a.js", "it.only('t', () => {})\n");
    expect(await run.stop({ last_assistant_message: "Done." })).toEqual(drift("a.js:2  it.only('t', () => {})"));
    expect([...(findSession(run.sessionId)?.stopBlocks ?? [])]).toEqual([
      ["task-continuation", 1],
      ["drift-guard", 1],
    ]);
    git(run.root, "checkout", "-q", "--", "a.js");
    expect(await run.stop({ last_assistant_message: "Done." })).toEqual({});
    expect([...(findSession(run.sessionId)?.stopBlocks ?? [])]).toEqual([["task-continuation", 1]]);
  });
});

describe("disjointness matrix", () => {
  async function firing(run: Stop): Promise<StopGate[]> {
    const fired: StopGate[] = [];
    for (const gate of GATES) {
      onlyGate(gate);
      if ((await run.stop({ last_assistant_message: CLAIM })).hookSpecificOutput !== undefined) fired.push(gate);
    }
    return fired;
  }

  async function listRepository(tasks: readonly Task[], withStub = false): Promise<Stop> {
    const run = session(repository());
    write(run.root, "a.txt", "hello\n");
    commitAll(run.root);
    writeTasks(run.sessionId, ...tasks);
    await touch(run);
    if (withStub) write(run.root, "stub.sh", `# ${UNFINISHED} pagination\n`);
    return run;
  }

  test("disjointness matrix: a run with an open task", async () => {
    expect(await firing(await listRepository([FIRST_DONE, SECOND_OPEN]))).toEqual(["task-continuation"]);
  });

  test("disjointness matrix: a run with every task completed", async () => {
    expect(await firing(await listRepository([FIRST_DONE]))).toEqual([]);
  });

  test("disjointness matrix: tasks with no run", async () => {
    expect(await firing(await listRepository([task("1", "Ad hoc", { metadata: {} })]))).toEqual([]);
  });

  test("disjointness matrix: drift-guard co-fires with task continuation on a stub plus an open task", async () => {
    expect(await firing(await listRepository([FIRST_DONE, SECOND_OPEN], true))).toEqual(["task-continuation", "drift-guard"]);
  });

  test("disjointness matrix: two co-firing gates still run out of Stop-block budget", async () => {
    const run = await listRepository([FIRST_DONE, SECOND_OPEN], true);
    const stub = drift(`stub.sh:1  # ${UNFINISHED} pagination`);
    expect(await stops(run, 8, { last_assistant_message: CLAIM })).toEqual([CONTINUE, stub, stub, stub, stub, stub, {}, {}]);
  });
});

describe("the Stop handler", () => {
  test("stop-gates in OMCA_DISABLED_HOOKS turns off every gate", async () => {
    const run = session(repository());
    write(run.root, "a.txt", "hello\n");
    commitAll(run.root);
    writeTasks(run.sessionId, FIRST_DONE, SECOND_OPEN);
    await touch(run);
    write(run.root, "stub.sh", `# ${UNFINISHED} pagination\n`);
    process.env.OMCA_DISABLED_HOOKS = "stop-gates";
    expect(await run.stop({ last_assistant_message: CLAIM })).toEqual({});
  });

  test("the retired gate names turn nothing off", async () => {
    const run = await openRun();
    process.env.OMCA_DISABLED_HOOKS = "plan-continuation,final-verification";
    expect(await run.stop()).toEqual(CONTINUE);
  });

  test("hooks.json routes Stop to omca_hook through one entry and registers no StopFailure handler", () => {
    const { hooks } = JSON.parse(readFileSync(HOOKS, "utf8"));
    expect(hooks.StopFailure).toBeUndefined();
    expect(hooks.Stop).toEqual([
      {
        hooks: [
          {
            type: "mcp_tool",
            server: "plugin:oh-my-claudeagent:omca",
            tool: "omca_hook",
            timeout: 15,
            input: {
              event: "Stop",
              session_id: "${session_id}",
              transcript_path: "${transcript_path}",
              stop_hook_active: "${stop_hook_active}",
              last_assistant_message: "${last_assistant_message}",
              background_tasks: "${background_tasks}",
            },
          },
        ],
      },
    ]);
  });
});
