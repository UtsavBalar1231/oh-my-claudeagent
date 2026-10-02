import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle as guidance } from "./guidance.ts";
import { dispatch, type Output, type Payload } from "./registry.ts";
import { handle as sessionStart } from "./session-start.ts";
import { findSession, touchSession } from "./session-state.ts";
import { statusPath } from "./status-file.ts";

const REPO = join(import.meta.dir, "..", "..");
const TEMPLATE = readFileSync(join(REPO, "templates", "claudemd.md"), "utf8");
const FIXTURES = join(REPO, "tests", "fixtures", "home");
const NOW = 1_786_000_000_000;

const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT };
const roots: string[] = [];

const restore = (name: keyof typeof saved) => {
  const value = saved[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeAll(() => {
  delete process.env.CLAUDE_PLUGIN_ROOT;
});

afterAll(() => {
  for (const name of ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_ROOT"] as const) restore(name);
});

afterEach(() => {
  restore("HOME");
  restore("CLAUDE_CONFIG_DIR");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(fixture: "with-block" | "without-block", via: "HOME" | "CLAUDE_CONFIG_DIR" = "CLAUDE_CONFIG_DIR"): void {
  if (via === "HOME") {
    process.env.HOME = join(FIXTURES, fixture);
    process.env.CLAUDE_CONFIG_DIR = "";
  } else {
    process.env.HOME = join(FIXTURES, "missing");
    process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, fixture, ".claude");
  }
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-guidance-"));
  roots.push(root);
  return root;
}

function bind(root: string, sessionId: string, planFile: string): void {
  mkdirSync(join(root, ".omca", "state"), { recursive: true });
  const registry = {
    plans: { "hello-plan": { active_plan: planFile, started_at: "2026-10-02T10:00:00Z", session_ids: [sessionId] } },
    bindings: { [sessionId]: { plan_name: "hello-plan", bound_at: 1_786_000_000 } },
  };
  writeFileSync(join(root, ".omca", "state", "boulder.json"), JSON.stringify(registry));
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

const injected = (event: string, sessionId: string): Output => ({
  hookSpecificOutput: { hookEventName: event, additionalContext: `${TEMPLATE}\nSession ${sessionId}` },
});

describe("first-prompt guidance", () => {
  test("the first prompt of a session gets the template and its Session line", () => {
    home("without-block");
    const id = crypto.randomUUID();
    expect(run(prompt("UserPromptSubmit", id))).toEqual(injected("UserPromptSubmit", id));
  });

  test("later prompts of the same session get nothing", () => {
    home("without-block");
    const id = crypto.randomUUID();
    run(prompt("UserPromptSubmit", id));
    expect(run(prompt("UserPromptSubmit", id))).toBeUndefined();
    expect(run(prompt("UserPromptExpansion", id))).toBeUndefined();
  });

  test("a second session id gets its own injection", () => {
    home("without-block");
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    expect(run(prompt("UserPromptSubmit", first))).toEqual(injected("UserPromptSubmit", first));
    expect(run(prompt("UserPromptSubmit", second))).toEqual(injected("UserPromptSubmit", second));
    expect(run(prompt("UserPromptSubmit", first))).toBeUndefined();
  });

  test("a typed slash command gets the template on UserPromptExpansion and nothing again on its UserPromptSubmit", () => {
    home("without-block");
    const id = crypto.randomUUID();
    expect(run(prompt("UserPromptExpansion", id))).toEqual(injected("UserPromptExpansion", id));
    expect(run(prompt("UserPromptSubmit", id))).toBeUndefined();
  });

  test("a 2.x setup block in CLAUDE_CONFIG_DIR's CLAUDE.md holds the template back", () => {
    home("with-block");
    const id = crypto.randomUUID();
    expect(run(prompt("UserPromptSubmit", id))).toBeUndefined();
    home("without-block");
    expect(run(prompt("UserPromptSubmit", id))).toBeUndefined();
  });

  test("with CLAUDE_CONFIG_DIR empty the CLAUDE.md under HOME decides", () => {
    home("with-block", "HOME");
    expect(run(prompt("UserPromptSubmit", crypto.randomUUID()))).toBeUndefined();
    home("without-block", "HOME");
    const id = crypto.randomUUID();
    expect(run(prompt("UserPromptSubmit", id))).toEqual(injected("UserPromptSubmit", id));
  });

  test("a missing CLAUDE.md does not hold the template back", () => {
    process.env.HOME = join(FIXTURES, "missing");
    delete process.env.CLAUDE_CONFIG_DIR;
    const id = crypto.randomUUID();
    expect(run(prompt("UserPromptSubmit", id))).toEqual(injected("UserPromptSubmit", id));
  });

  test("a fresh session id with no status file gets the template", () => {
    home("without-block");
    const root = project();
    const id = crypto.randomUUID();
    expect(run(prompt("UserPromptSubmit", id), root)).toEqual(injected("UserPromptSubmit", id));
  });

  test("a resumed session, whose status file an earlier server process wrote, gets nothing", () => {
    home("without-block");
    const root = project();
    const id = crypto.randomUUID();
    mkdirSync(join(root, ".omca", "state", "session"), { recursive: true });
    writeFileSync(statusPath(root, id), JSON.stringify({ session_id: id, last_hook_at: 1, verification: null }));
    expect(run(prompt("UserPromptSubmit", id), root)).toBeUndefined();
  });

  test("a status file this process stamped, as after /clear's SessionStart, does not hold the template back", () => {
    home("without-block");
    const root = project();
    const id = crypto.randomUUID();
    mkdirSync(join(root, ".omca", "state", "session"), { recursive: true });
    writeFileSync(statusPath(root, id), JSON.stringify({ session_id: id, last_hook_at: 1, verification: null }));
    touchSession(id).stampedAt = NOW - 1_000;
    expect(run(prompt("UserPromptSubmit", id), root)).toEqual(injected("UserPromptSubmit", id));
  });

  test("through dispatch, a resumed session's first prompt gets nothing and a session begun by /clear gets the template", async () => {
    home("without-block");
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
    home("without-block");
    const id = crypto.randomUUID();
    run(prompt("UserPromptSubmit", id), project(), NOW);
    run(prompt("UserPromptExpansion", id), project(), NOW + 5_000);
    expect(findSession(id)?.promptAt).toBe(NOW + 5_000);
  });
});

describe("session title", () => {
  test("the first UserPromptSubmit titles the session after its bound plan", () => {
    home("with-block");
    const root = project();
    const id = crypto.randomUUID();
    const plan = join(root, "hello-plan.md");
    writeFileSync(plan, "- [ ] 1. Say hello\n");
    bind(root, id, plan);
    expect(run(prompt("UserPromptSubmit", id), root)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: "OMCA: hello-plan" },
    });
    expect(run(prompt("UserPromptSubmit", id), root)).toBeUndefined();
  });

  test("the title waits for UserPromptSubmit after a slash command's UserPromptExpansion", () => {
    home("without-block");
    const root = project();
    const id = crypto.randomUUID();
    const plan = join(root, "hello-plan.md");
    writeFileSync(plan, "- [ ] 1. Say hello\n");
    bind(root, id, plan);
    expect(run(prompt("UserPromptExpansion", id), root)).toEqual(injected("UserPromptExpansion", id));
    expect(run(prompt("UserPromptSubmit", id), root)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: "OMCA: hello-plan" },
    });
  });

  test("a title the user set is kept", () => {
    home("with-block");
    const root = project();
    const id = crypto.randomUUID();
    const plan = join(root, "hello-plan.md");
    writeFileSync(plan, "- [ ] 1. Say hello\n");
    bind(root, id, plan);
    expect(run(prompt("UserPromptSubmit", id, { session_title: "my session" }), root)).toBeUndefined();
  });

  test("an unbound session, a bound plan whose file is gone, and a missing registry set no title", () => {
    home("with-block");
    const root = project();
    const bound = crypto.randomUUID();
    bind(root, bound, join(root, "deleted.md"));
    expect(run(prompt("UserPromptSubmit", bound), root)).toBeUndefined();
    expect(run(prompt("UserPromptSubmit", crypto.randomUUID()), root)).toBeUndefined();
    expect(run(prompt("UserPromptSubmit", crypto.randomUUID()))).toBeUndefined();
  });
});

describe("compaction", () => {
  const start = (source: string): Payload => ({ event: "SessionStart", session_id: crypto.randomUUID(), cwd: "/work", source });
  const context = { root: "/work", now: NOW, session: undefined };

  test("SessionStart for compact adds the template again", () => {
    home("without-block");
    expect(sessionStart(start("compact"), context)).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: TEMPLATE },
    });
  });

  test("SessionStart for clear adds nothing, since the new session's first prompt carries the template", () => {
    home("without-block");
    expect(sessionStart(start("clear"), context)).toBeUndefined();
  });

  test("a 2.x setup block holds the compact re-injection back", () => {
    home("with-block");
    expect(sessionStart(start("compact"), context)).toBeUndefined();
  });
});
