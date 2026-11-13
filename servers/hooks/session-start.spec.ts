import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "./registry.ts";
import { findSession } from "./session-state.ts";

const REPO = join(import.meta.dir, "..", "..");
const TEMPLATE = readFileSync(join(REPO, "templates", "claudemd.md"), "utf8");
const NOW = 1_786_000_000_000;
const NOTEPAD =
  "[NOTEPAD] Record discoveries, decisions and blockers with notepad_write('hello-run', section, content); the sections are learnings, issues, decisions and problems.";

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
  config = mkdtempSync(join(tmpdir(), "omca-session-start-config-"));
  roots.push(config);
  process.env.CLAUDE_CONFIG_DIR = config;
});

afterEach(() => {
  delete process.env.CLAUDE_CODE_TASK_LIST_ID;
  delete process.env.OMCA_DISABLED_HOOKS;
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-session-start-"));
  roots.push(root);
  return root;
}

function writeRun(sessionId: string): void {
  process.env.CLAUDE_CODE_TASK_LIST_ID = sessionId;
  const dir = join(config, "tasks", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "1.json"), JSON.stringify({ id: "1", subject: "Parse", status: "completed", metadata: { run: "hello-run" } }));
  writeFileSync(join(dir, "2.json"), JSON.stringify({ id: "2", subject: "Say hello", status: "pending", metadata: { run: "hello-run" } }));
}

const start = (sessionId: string, source: string, root: string): Promise<unknown> =>
  dispatch({ event: "SessionStart", session_id: sessionId, cwd: root, source }, root, NOW);

const firstPrompt = (sessionId: string, root: string): Promise<unknown> =>
  dispatch({ event: "UserPromptSubmit", session_id: sessionId, cwd: root, prompt: "go" }, root, NOW);

const context = (text: string) => ({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });

describe("compaction", () => {
  test("SessionStart for compact re-injects the template, the session id and the open run's next task and notepad line", async () => {
    const root = project();
    const id = crypto.randomUUID();
    writeRun(id);
    expect(await start(id, "compact", root)).toEqual(context(`${TEMPLATE}\nSession ${id}\n[ACTIVE RUN] hello-run: 1 open, next #2 Say hello\n${NOTEPAD}`));
  });

  test("SessionStart for compact with no run re-injects the template and the session id", async () => {
    const id = crypto.randomUUID();
    expect(await start(id, "compact", project())).toEqual(context(`${TEMPLATE}\nSession ${id}`));
  });

  test("SessionStart for compact records the compaction time in the session", async () => {
    const id = crypto.randomUUID();
    await start(id, "compact", project());
    expect(findSession(id)?.compactedAt).toBe(NOW);
  });

  test("a compact payload that carries no session id re-injects the template alone", async () => {
    expect(await dispatch({ event: "SessionStart", source: "compact" }, project(), NOW)).toEqual(context(TEMPLATE));
  });

  test("a subagent's compaction injects nothing and leaves the main conversation's compaction time unset", async () => {
    const root = project();
    const id = crypto.randomUUID();
    writeRun(id);
    expect(await dispatch({ event: "SessionStart", session_id: id, cwd: root, source: "compact", agent_id: "a1b2c3" }, root, NOW)).toEqual({});
    expect(findSession(id)?.compactedAt).toBeUndefined();
  });

  test("the empty agent_id the client substitutes for the main conversation still re-injects", async () => {
    const id = crypto.randomUUID();
    expect(await dispatch({ event: "SessionStart", session_id: id, cwd: project(), source: "compact", agent_id: "" }, project(), NOW)).toEqual(context(`${TEMPLATE}\nSession ${id}`));
    expect(findSession(id)?.compactedAt).toBe(NOW);
  });
});

describe("clear", () => {
  test("SessionStart for clear answers nothing, and the new session's first prompt gets the guidance", async () => {
    const root = project();
    const id = crypto.randomUUID();
    expect(await start(id, "clear", root)).toEqual({});
    expect(await firstPrompt(id, root)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `${TEMPLATE}\nSession ${id}` },
    });
  });
});

describe("kill switch", () => {
  test("OMCA_DISABLED_HOOKS=session-start silences compact and clear, and still records the compaction", async () => {
    process.env.OMCA_DISABLED_HOOKS = "session-start";
    const root = project();
    const id = crypto.randomUUID();
    expect(await start(id, "compact", root)).toEqual({});
    expect(findSession(id)?.compactedAt).toBe(NOW);
    expect(await start(id, "clear", root)).toEqual({});
  });
});
