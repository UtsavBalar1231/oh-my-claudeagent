import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
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
const roots: string[] = [];

beforeAll(() => {
  delete process.env.CLAUDE_PLUGIN_ROOT;
});

afterAll(() => {
  if (pluginRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

const injected = (event: string, sessionId: string, plan = ""): Output => ({
  hookSpecificOutput: { hookEventName: event, additionalContext: `${TEMPLATE}\nSession ${sessionId}${plan}` },
});

const planLines = (path: string, next: string): string =>
  `\n[ACTIVE PLAN] hello-plan: ${path}\n[NEXT TASK] ${next}\n` +
  "[NOTEPAD] Record discoveries, decisions and blockers with notepad_write('hello-plan', section, content); the sections are learnings, issues, decisions and problems.";

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

  test("a typed slash command gets the template on UserPromptExpansion and nothing again on its UserPromptSubmit", () => {
    const id = crypto.randomUUID();
    expect(run(prompt("UserPromptExpansion", id))).toEqual(injected("UserPromptExpansion", id));
    expect(run(prompt("UserPromptSubmit", id))).toBeUndefined();
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

describe("bound plan context", () => {
  test("the first prompt of a plan-bound session carries the plan's name, path, next open task and notepad line", () => {
    const root = project();
    const id = crypto.randomUUID();
    const plan = join(root, "hello-plan.md");
    writeFileSync(plan, "# Hello\n\n- [x] 1. Write the parser\n- [ ] 2. Say hello\n- [ ] 3. Say goodbye\n");
    bind(root, id, plan);
    expect(run(prompt("UserPromptExpansion", id), root)).toEqual(injected("UserPromptExpansion", id, planLines(plan, "Say hello")));
  });

  test("a plan whose numbered tasks are all checked says none is open", () => {
    const root = project();
    const id = crypto.randomUUID();
    const plan = join(root, "hello-plan.md");
    writeFileSync(plan, "- [x] 1. Say hello\n");
    bind(root, id, plan);
    expect(run(prompt("UserPromptExpansion", id), root)).toEqual(
      injected("UserPromptExpansion", id, planLines(plan, "None open: every numbered task is checked.")),
    );
  });

  test("an unreadable registry is logged and the template still goes out", () => {
    const root = project();
    const id = crypto.randomUUID();
    mkdirSync(join(root, ".omca", "state"), { recursive: true });
    writeFileSync(join(root, ".omca", "state", "boulder.json"), "{not json");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(run(prompt("UserPromptExpansion", id), root)).toEqual(injected("UserPromptExpansion", id));
      expect(errors.mock.calls.map(([message]) => message)).toEqual(["omca: guidance could not read this session's bound plan:"]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("session title", () => {
  test("the first UserPromptSubmit titles the session after its bound plan", () => {
    const root = project();
    const id = crypto.randomUUID();
    const plan = join(root, "hello-plan.md");
    writeFileSync(plan, "- [ ] 1. Say hello\n");
    bind(root, id, plan);
    expect(run(prompt("UserPromptSubmit", id), root)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `${TEMPLATE}\nSession ${id}${planLines(plan, "Say hello")}`,
        sessionTitle: "OMCA: hello-plan",
      },
    });
    expect(run(prompt("UserPromptSubmit", id), root)).toBeUndefined();
  });

  test("the title waits for UserPromptSubmit after a slash command's UserPromptExpansion", () => {
    const root = project();
    const id = crypto.randomUUID();
    const plan = join(root, "hello-plan.md");
    writeFileSync(plan, "- [ ] 1. Say hello\n");
    bind(root, id, plan);
    expect(run(prompt("UserPromptExpansion", id), root)).toEqual(injected("UserPromptExpansion", id, planLines(plan, "Say hello")));
    expect(run(prompt("UserPromptSubmit", id), root)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: "OMCA: hello-plan" },
    });
  });

  test("a title the user set is kept", () => {
    const root = project();
    const id = crypto.randomUUID();
    const plan = join(root, "hello-plan.md");
    writeFileSync(plan, "- [ ] 1. Say hello\n");
    bind(root, id, plan);
    expect(run(prompt("UserPromptSubmit", id, { session_title: "my session" }), root)).toEqual(
      injected("UserPromptSubmit", id, planLines(plan, "Say hello")),
    );
  });

  test("an unbound session, a bound plan whose file is gone, and a missing registry set no title", () => {
    const root = project();
    const bound = crypto.randomUUID();
    bind(root, bound, join(root, "deleted.md"));
    const unbound = crypto.randomUUID();
    const unregistered = crypto.randomUUID();
    expect(run(prompt("UserPromptSubmit", bound), root)).toEqual(injected("UserPromptSubmit", bound));
    expect(run(prompt("UserPromptSubmit", unbound), root)).toEqual(injected("UserPromptSubmit", unbound));
    expect(run(prompt("UserPromptSubmit", unregistered))).toEqual(injected("UserPromptSubmit", unregistered));
  });
});

describe("output style", () => {
  test("output-styles/omca-default.md: carries the minimal-code coding discipline", () => {
    expect(readFileSync(join(REPO, "output-styles", "omca-default.md"), "utf8")).toContain("Write the minimum that solves the problem");
  });
});
