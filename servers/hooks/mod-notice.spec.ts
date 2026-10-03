import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, MOD_NOT_RUNNING } from "./mod-notice.ts";
import { dispatch, type Output } from "./registry.ts";
import { findSession, touchSession } from "./session-state.ts";

const NOW = 1_786_000_000_000;
let launch = "";
let cleared = "";

const saved = { id: process.env.CLAUDE_CODE_SESSION_ID, plugin: process.env.CLAUDE_PLUGIN_ROOT, disabled: process.env.OMCA_DISABLED_HOOKS };
const roots: string[] = [];

beforeAll(() => {
  delete process.env.CLAUDE_PLUGIN_ROOT;
});

afterAll(() => {
  if (saved.plugin !== undefined) process.env.CLAUDE_PLUGIN_ROOT = saved.plugin;
});

beforeEach(() => {
  launch = crypto.randomUUID();
  cleared = crypto.randomUUID();
  process.env.CLAUDE_CODE_SESSION_ID = launch;
  delete process.env.OMCA_DISABLED_HOOKS;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (saved.id === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = saved.id;
  if (saved.disabled === undefined) delete process.env.OMCA_DISABLED_HOOKS;
  else process.env.OMCA_DISABLED_HOOKS = saved.disabled;
});

function project(marker?: { id: string; text: string }): string {
  const root = mkdtempSync(join(tmpdir(), "omca-mod-notice-"));
  roots.push(root);
  if (marker !== undefined) {
    mkdirSync(join(root, ".omca", "state", "mod"), { recursive: true });
    writeFileSync(join(root, ".omca", "state", "mod", `${marker.id}.json`), marker.text);
  }
  return root;
}

const marked = (id: string) => ({ id, text: JSON.stringify({ written_at: NOW - 5_000 }) });
const prompt = (root: string, id: string) => handle({ event: "UserPromptSubmit", session_id: id }, { root, now: NOW, session: touchSession(id) });

test("the launch session's first prompt with no marker gets the notice, and no later prompt does", async () => {
  const root = project();
  expect(await prompt(root, launch)).toEqual({ systemMessage: MOD_NOT_RUNNING });
  expect(await prompt(root, launch)).toBeUndefined();
  expect(await prompt(root, launch)).toBeUndefined();
});

test("the launch session's first prompt with a marker gets nothing, even if the marker is a day old", async () => {
  const root = project({ id: launch, text: JSON.stringify({ written_at: NOW - 86_400_000 }) });
  expect(await prompt(root, launch)).toBeUndefined();
  expect(findSession(launch)?.isModChecked).toBe(true);
});

test("a session that /clear started has no marker before its first turn, so its first prompt gets nothing", async () => {
  const root = project();
  expect(await prompt(root, cleared)).toBeUndefined();
  expect(findSession(cleared)?.isModChecked).toBeUndefined();
});

test("the notice is for the launch session even when a cleared session's marker exists", async () => {
  const root = project(marked(cleared));
  expect(await prompt(root, launch)).toEqual({ systemMessage: MOD_NOT_RUNNING });
});

test("a server whose environment names no session never says it", async () => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  expect(await prompt(project(), launch)).toBeUndefined();
});

test("a prompt that carries no session id gets nothing", async () => {
  expect(await handle({ event: "UserPromptSubmit" }, { root: project(), now: NOW, session: undefined })).toBeUndefined();
});

test("OMCA_DISABLED_HOOKS=mod-notice silences it", async () => {
  process.env.OMCA_DISABLED_HOOKS = "mod-notice";
  expect(await prompt(project(), launch)).toBeUndefined();
});

test("a marker that cannot be parsed raises no notice, because the mod's state is unknown", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const root = project({ id: launch, text: "{ half a marker" });
    const output: Output = await dispatch({ event: "UserPromptSubmit", session_id: launch }, root, NOW);
    expect(output.systemMessage).toBeUndefined();
    expect(errors.mock.calls.map((call) => call[0])).toEqual(["omca: UserPromptSubmit handler mod-notice failed:"]);
  } finally {
    errors.mockRestore();
  }
});

test("a first prompt with no marker answers the guidance and the notice together, once", async () => {
  const root = project();
  const first = await dispatch({ event: "UserPromptSubmit", session_id: launch, prompt: "go" }, root, NOW);
  expect(first.systemMessage).toBe(MOD_NOT_RUNNING);
  expect(first.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
  const second = await dispatch({ event: "UserPromptSubmit", session_id: launch, prompt: "again" }, root, NOW);
  expect(second).toEqual({});
});
