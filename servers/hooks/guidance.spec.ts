import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle as guidance } from "./guidance.ts";
import { dispatch, type Output, type Payload } from "./registry.ts";
import { findSession, touchSession } from "./session-state.ts";
import { statusPath } from "./status-file.ts";

const REPO = join(import.meta.dir, "..", "..");
const TEMPLATE = readFileSync(join(REPO, "templates", "claudemd.md"), "utf8");
const NOW = 1_786_000_000_000;

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
const configDir = process.env.CLAUDE_CONFIG_DIR;
const roots: string[] = [];
let config: string;

beforeAll(() => {
  delete process.env.CLAUDE_PLUGIN_ROOT;
});

afterAll(() => {
  if (pluginRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
});

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "omca-guidance-config-"));
  roots.push(config);
  process.env.CLAUDE_CONFIG_DIR = config;
});

afterEach(() => {
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-guidance-"));
  roots.push(root);
  return root;
}

function mark(root: string, sessionId: string, listId = sessionId): void {
  mkdirSync(join(root, ".omca", "state", "mod"), { recursive: true });
  writeFileSync(join(root, ".omca", "state", "mod", `${sessionId}.json`), JSON.stringify({ written_at: NOW, task_list: listId }));
}

function writeTasks(listId: string, ...tasks: readonly Record<string, unknown>[]): void {
  const dir = join(config, "tasks", listId);
  mkdirSync(dir, { recursive: true });
  for (const task of tasks) writeFileSync(join(dir, `${String(task.id)}.json`), JSON.stringify({ description: "", status: "pending", metadata: { run: "hello-run" }, ...task }));
}

const prompt = (event: "UserPromptSubmit" | "UserPromptExpansion", sessionId: string, extra: Record<string, string> = {}): Payload => ({
  event,
  session_id: sessionId,
  cwd: "/work",
  prompt: "add a hello command",
  ...extra,
});

const run = (payload: Payload, root = project(), now = NOW): Output | undefined =>
  guidance(payload, { root, now, session: touchSession(String(payload.session_id)) }) as Output | undefined;

const injected = (event: string, sessionId: string, run = ""): Output => ({
  hookSpecificOutput: { hookEventName: event, additionalContext: `${TEMPLATE}\nSession ${sessionId}${run}` },
});

const runLines = (open: string): string =>
  `\n[ACTIVE RUN] hello-run: ${open}\n` +
  "[NOTEPAD] Record discoveries, decisions and blockers with notepad_write('hello-run', section, content); the sections are learnings, issues, decisions and problems.";

describe("first-prompt guidance", () => {
  test("the first prompt of a session gets the template and its Session line", () => {
    const id = crypto.randomUUID();
    expect(run(prompt("UserPromptSubmit", id))).toEqual(injected("UserPromptSubmit", id));
  });

  test("later prompts of the same session get nothing", () => {
    const id = crypto.randomUUID();
    run(prompt("UserPromptSubmit", id));
    expect(run(prompt("UserPromptSubmit", id))).toBeUndefined();
    expect(run(prompt("UserPromptExpansion", id))).toBeUndefined();
  });

  test("a second session id gets its own injection", () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    expect(run(prompt("UserPromptSubmit", first))).toEqual(injected("UserPromptSubmit", first));
    expect(run(prompt("UserPromptSubmit", second))).toEqual(injected("UserPromptSubmit", second));
    expect(run(prompt("UserPromptSubmit", first))).toBeUndefined();
  });

  test("a typed slash command gets the template on UserPromptSubmit and nothing again on its UserPromptExpansion", () => {
    const id = crypto.randomUUID();
    expect(run(prompt("UserPromptSubmit", id))).toEqual(injected("UserPromptSubmit", id));
    expect(run(prompt("UserPromptExpansion", id))).toBeUndefined();
  });

  test("a fresh session id with no status file gets the template", () => {
    const root = project();
    const id = crypto.randomUUID();
    expect(run(prompt("UserPromptSubmit", id), root)).toEqual(injected("UserPromptSubmit", id));
  });

  test("a resumed session, whose status file an earlier server process wrote, gets nothing", () => {
    const root = project();
    const id = crypto.randomUUID();
    mkdirSync(join(root, ".omca", "state", "session"), { recursive: true });
    writeFileSync(statusPath(root, id), JSON.stringify({ session_id: id, last_hook_at: 1, verification: null }));
    expect(run(prompt("UserPromptSubmit", id), root)).toBeUndefined();
  });

  test("a status file this process stamped, as after /clear's SessionStart, does not hold the template back", () => {
    const root = project();
    const id = crypto.randomUUID();
    mkdirSync(join(root, ".omca", "state", "session"), { recursive: true });
    writeFileSync(statusPath(root, id), JSON.stringify({ session_id: id, last_hook_at: 1, verification: null }));
    touchSession(id).stampedAt = NOW - 1_000;
    expect(run(prompt("UserPromptSubmit", id), root)).toEqual(injected("UserPromptSubmit", id));
  });

  test("through dispatch, a resumed session's first prompt gets nothing and a session begun by /clear gets the template", async () => {
    const root = project();
    const resumed = crypto.randomUUID();
    mkdirSync(join(root, ".omca", "state", "session"), { recursive: true });
    writeFileSync(statusPath(root, resumed), JSON.stringify({ session_id: resumed, last_hook_at: 1, verification: null }));
    expect(await dispatch(prompt("UserPromptSubmit", resumed), root, NOW)).toEqual({});
    const cleared = crypto.randomUUID();
    expect(await dispatch({ event: "SessionStart", session_id: cleared, cwd: "/work", source: "clear" }, root, NOW)).toEqual({});
    expect(await dispatch(prompt("UserPromptSubmit", cleared), root, NOW)).toEqual(injected("UserPromptSubmit", cleared));
  });

  test("every prompt records its time for health_check", () => {
    const id = crypto.randomUUID();
    run(prompt("UserPromptSubmit", id), project(), NOW);
    run(prompt("UserPromptExpansion", id), project(), NOW + 5_000);
    expect(findSession(id)?.promptAt).toBe(NOW + 5_000);
  });
});

describe("run context", () => {
  test("the first prompt carries the run's name, open count, next task and notepad line", () => {
    const root = project();
    const id = crypto.randomUUID();
    mark(root, id);
    writeTasks(id, { id: "1", subject: "Write the parser", status: "completed" }, { id: "2", subject: "Say hello" }, { id: "3", subject: "Say goodbye", blockedBy: ["2"] });
    expect(run(prompt("UserPromptExpansion", id), root)).toEqual(injected("UserPromptExpansion", id, runLines("2 open, next #2 Say hello")));
  });

  test("the marker's list is the one read", () => {
    const root = project();
    const id = crypto.randomUUID();
    writeTasks("omca-shared", { id: "1", subject: "Say hello" });
    mkdirSync(join(root, ".omca", "state", "mod"), { recursive: true });
    writeFileSync(join(root, ".omca", "state", "mod", `${id}.json`), JSON.stringify({ written_at: NOW, task_list: "omca-shared" }));
    expect(run(prompt("UserPromptExpansion", id), root)).toEqual(injected("UserPromptExpansion", id, runLines("1 open, next #1 Say hello")));
  });

  test("a run with nothing open adds no line", () => {
    const root = project();
    const id = crypto.randomUUID();
    mark(root, id);
    writeTasks(id, { id: "1", subject: "Say hello", status: "completed" }, { id: "2", subject: "Wave", metadata: { run: "hello-run", blocked: "no hand" } });
    expect(run(prompt("UserPromptExpansion", id), root)).toEqual(injected("UserPromptExpansion", id));
  });

  test("tasks with no run add no line", () => {
    const root = project();
    const id = crypto.randomUUID();
    mark(root, id);
    writeTasks(id, { id: "1", subject: "Say hello", metadata: {} });
    expect(run(prompt("UserPromptExpansion", id), root)).toEqual(injected("UserPromptExpansion", id));
  });

  test("the run's line does not depend on the session having touched a task", () => {
    const root = project();
    const id = crypto.randomUUID();
    mark(root, id);
    writeTasks(id, { id: "1", subject: "Say hello" });
    expect(findSession(id)?.hasTouchedTask).toBeUndefined();
    expect(run(prompt("UserPromptExpansion", id), root)).toEqual(injected("UserPromptExpansion", id, runLines("1 open, next #1 Say hello")));
  });
});

describe("session title", () => {
  test("the first UserPromptSubmit titles the session after its run", () => {
    const root = project();
    const id = crypto.randomUUID();
    mark(root, id);
    writeTasks(id, { id: "1", subject: "Say hello" });
    expect(run(prompt("UserPromptSubmit", id), root)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `${TEMPLATE}\nSession ${id}${runLines("1 open, next #1 Say hello")}`,
        sessionTitle: "OMCA: hello-run",
      },
    });
    expect(run(prompt("UserPromptSubmit", id), root)).toBeUndefined();
  });

  test("a slash command's UserPromptSubmit carries the title and its UserPromptExpansion adds nothing", () => {
    const root = project();
    const id = crypto.randomUUID();
    mark(root, id);
    writeTasks(id, { id: "1", subject: "Say hello" });
    expect(run(prompt("UserPromptSubmit", id), root)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `${TEMPLATE}\nSession ${id}${runLines("1 open, next #1 Say hello")}`,
        sessionTitle: "OMCA: hello-run",
      },
    });
    expect(run(prompt("UserPromptExpansion", id), root)).toBeUndefined();
  });

  test("a title the user set is kept", () => {
    const root = project();
    const id = crypto.randomUUID();
    mark(root, id);
    writeTasks(id, { id: "1", subject: "Say hello" });
    expect(run(prompt("UserPromptSubmit", id, { session_title: "my session" }), root)).toEqual(injected("UserPromptSubmit", id, runLines("1 open, next #1 Say hello")));
  });

  test("a resumed session's first prompt still gets the title and no template", () => {
    const root = project();
    const id = crypto.randomUUID();
    mark(root, id);
    writeTasks(id, { id: "1", subject: "Say hello" });
    mkdirSync(join(root, ".omca", "state", "session"), { recursive: true });
    writeFileSync(statusPath(root, id), JSON.stringify({ session_id: id, last_hook_at: 1, verification: null }));
    expect(run(prompt("UserPromptSubmit", id), root)).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: "OMCA: hello-run" } });
  });

  test("a session with no tasks and a run with nothing open set no title", () => {
    const root = project();
    const closed = crypto.randomUUID();
    mark(root, closed);
    writeTasks(closed, { id: "1", subject: "Say hello", status: "completed" });
    const none = crypto.randomUUID();
    expect(run(prompt("UserPromptSubmit", closed), root)).toEqual(injected("UserPromptSubmit", closed));
    expect(run(prompt("UserPromptSubmit", none), root)).toEqual(injected("UserPromptSubmit", none));
  });
});

describe("output style", () => {
  test("output-styles/omca-default.md: carries the minimal-code coding discipline", () => {
    expect(readFileSync(join(REPO, "output-styles", "omca-default.md"), "utf8")).toContain("Write the minimum that solves the problem");
  });
});
