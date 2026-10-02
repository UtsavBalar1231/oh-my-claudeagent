import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "./registry.ts";
import { findSession, touchSession } from "./session-state.ts";

const REPO = join(import.meta.dir, "..", "..");
const TEMPLATE = readFileSync(join(REPO, "templates", "claudemd.md"), "utf8");
const NOW = 1_786_000_000_000;
const NOTEPAD =
  "[NOTEPAD] Record discoveries, decisions and blockers with notepad_write('hello-plan', section, content); the sections are learnings, issues, decisions and problems.";

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
const roots: string[] = [];

beforeAll(() => {
  delete process.env.CLAUDE_PLUGIN_ROOT;
});

afterAll(() => {
  if (pluginRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
});

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-session-start-"));
  roots.push(root);
  return root;
}

function bindPlan(root: string, sessionId: string, content: string): string {
  const plan = join(root, "hello-plan.md");
  writeFileSync(plan, content);
  mkdirSync(join(root, ".omca", "state"), { recursive: true });
  const registry = {
    plans: { "hello-plan": { active_plan: plan, started_at: "2026-10-02T10:00:00Z", session_ids: [sessionId] } },
    bindings: { [sessionId]: { plan_name: "hello-plan", bound_at: 1_786_000_000 } },
  };
  writeFileSync(join(root, ".omca", "state", "boulder.json"), JSON.stringify(registry));
  return plan;
}

const start = (sessionId: string, source: string, root: string): Promise<unknown> =>
  dispatch({ event: "SessionStart", session_id: sessionId, cwd: root, source }, root, NOW);

const firstPrompt = (sessionId: string, root: string): Promise<unknown> =>
  dispatch({ event: "UserPromptSubmit", session_id: sessionId, cwd: root, prompt: "go" }, root, NOW);

const context = (text: string) => ({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });

describe("compaction", () => {
  test("SessionStart for compact re-injects the template, the session id and the bound plan's next task and notepad line", async () => {
    const root = project();
    const id = crypto.randomUUID();
    const plan = bindPlan(root, id, "- [x] 1. Parse\n- [ ] 2. Say hello\n");
    expect(await start(id, "compact", root)).toEqual(
      context(`${TEMPLATE}\nSession ${id}\n[ACTIVE PLAN] hello-plan: ${plan}\n[NEXT TASK] Say hello\n${NOTEPAD}`),
    );
  });

  test("SessionStart for compact in an unbound session re-injects the template and the session id", async () => {
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
});

describe("clear", () => {
  test("SessionStart for clear answers nothing and hands the guidance back to the session's next prompt", async () => {
    const root = project();
    const id = crypto.randomUUID();
    touchSession(id).isGuided = true;
    expect(await start(id, "clear", root)).toEqual({});
    expect(await firstPrompt(id, root)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `${TEMPLATE}\nSession ${id}` },
    });
  });
});

describe("kill switch", () => {
  test("OMCA_DISABLED_HOOKS=session-start silences compact and leaves the guided flag alone on clear", async () => {
    process.env.OMCA_DISABLED_HOOKS = "session-start";
    const root = project();
    const id = crypto.randomUUID();
    expect(await start(id, "compact", root)).toEqual({});
    expect(findSession(id)?.compactedAt).toBe(NOW);
    touchSession(id).isGuided = true;
    expect(await start(id, "clear", root)).toEqual({});
    expect(findSession(id)?.isGuided).toBe(true);
  });
});
