import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { taskListIdFor } from "../../src/core/native-tasks.ts";
import { ROOT, SESSION, type World, world, write } from "./world.ts";

const MARKER = `${ROOT}/.omca/state/mod/${SESSION}.json`;
const STARTED_MS = Date.UTC(2026, 9, 2, 12, 0, 0);

function engine(on: On, env: Readonly<Record<string, string>> = {}): World {
  const w = world(on, {}, {}, env);
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("session.usage", () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("fs.write", (_$, e) => (write(w, e.path, e.text), { value: undefined }));
  return w;
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
const marker = (w: World): unknown => JSON.parse(w.files.get(MARKER)?.text ?? "null");

test("session start writes the marker with its time, the plugin version and the options", async ($, on) => {
  const w = engine(on);
  await start($);
  const manifest = w.reads.find((path) => path.endsWith("/.claude-plugin/plugin.json")) ?? "";
  expect(marker(w)).toEqual({ written_at: STARTED_MS, version: null, options: { showBand: true, guardMode: "dialog", enableKeywordTriggers: false }, task_tools: true, task_list: null });
  expect(w.logs.filter((line) => line.startsWith("cannot read"))).toEqual([`cannot read the plugin version: ENOENT: no such file, ${manifest}`]);

  write(w, manifest, '{ "name": "oh-my-claudeagent", "version": "3.0.0" }');
  await w.clock.advance(60_000);
  await $.turn.start({ text: "go", turnId: "t-1" });
  expect(marker(w)).toEqual({
    written_at: STARTED_MS + 60_000,
    version: "3.0.0",
    options: { showBand: true, guardMode: "dialog", enableKeywordTriggers: false },
    task_tools: true,
    task_list: null,
  });
});

test("a session id that cannot name a file writes no marker and says so", async ($, on) => {
  const w = engine(on);
  w.sessionId = "../escape";
  await start($);

  expect([...w.files.keys()].filter((path) => path.includes("/.omca/state/mod/"))).toEqual([]);
  expect(w.logs).toContain('mod-marker: the session id "../escape" cannot name a file');
});

test("each main-loop turn start rewrites the marker with the turn's time", async ($, on) => {
  const w = engine(on);
  await start($);
  for (const turnId of ["t-1", "t-2"]) {
    await w.clock.advance(1_000);
    await $.turn.start({ text: "go", turnId });
  }
  expect(marker(w)).toMatchObject({ written_at: STARTED_MS + 2_000 });
});

test("a subagent's turn start writes no marker", async ($, on) => {
  const w = engine(on);
  await $.turn.start({ text: "go", turnId: "t-1", agentId: "a1" });
  expect(w.files.has(MARKER)).toBe(false);
});

test("the marker carries the plugin option that turns keyword triggers on", { options: { enableKeywordTriggers: true } }, async ($, on) => {
  const w = engine(on);
  await start($);
  expect(marker(w)).toMatchObject({ options: { enableKeywordTriggers: true } });
});

const LIST_ID = taskListIdFor(ROOT);
const TOOLS_ON = ["CLAUDE_CODE_ENABLE_TODO_TOOLS", "1"];
const LIST_NAMED = ["CLAUDE_CODE_TASK_LIST_ID", LIST_ID];

// `mock.env` answers reads from the variables it was given, so a set is fed back here as the client's
// would be. The read hook goes first, ahead of the one `world` registers, to see the set value.
function recording(on: On, env: Readonly<Record<string, string>> = {}): { w: World; sets: unknown[] } {
  const sets: unknown[] = [];
  const written = new Map<string, string>();
  on("env.get", { name: "CLAUDE_CODE_TASK_LIST_ID" }, (_$, e, next) => {
    const value = written.get(e.name);
    return value === undefined ? next(e) : { value };
  });
  const w = engine(on, env);
  on("env.set", (_$, e) => {
    sets.push([e.name, e.value]);
    if (e.value !== undefined) written.set(e.name, e.value);
    if (e.name === "CLAUDE_CODE_ENABLE_TODO_TOOLS") w.tools = ["Bash", "TaskCreate", "TaskUpdate"];
    return { value: {} };
  });
  return { w, sets };
}

test("session start turns the task tools on where nothing set the variable, and the marker reports them", async ($, on) => {
  const { w, sets } = recording(on);
  w.tools = ["Bash"];
  await start($);
  expect(sets).toEqual([TOOLS_ON, LIST_NAMED]);
  expect(marker(w)).toMatchObject({ task_tools: true });
});

test("a value someone set stays, and the marker reports the tools off", async ($, on) => {
  const { w, sets } = recording(on, { CLAUDE_CODE_ENABLE_TODO_TOOLS: "0" });
  w.tools = ["Bash"];
  await start($);
  expect(sets).toEqual([LIST_NAMED]);
  expect(marker(w)).toMatchObject({ task_tools: false });
});

test("session start names the checkout's task list where nothing named one, and the marker reports it", async ($, on) => {
  const { w, sets } = recording(on);
  await start($);
  expect(sets).toContainEqual(LIST_NAMED);
  expect(marker(w)).toMatchObject({ task_list: LIST_ID });
});

test("a task list id someone set stays, and the marker reports it", async ($, on) => {
  const { w, sets } = recording(on, { CLAUDE_CODE_TASK_LIST_ID: "the-org-list" });
  await start($);
  expect(sets).toEqual([TOOLS_ON]);
  expect(marker(w)).toMatchObject({ task_list: "the-org-list" });
});

test("an empty task list id counts as unset", async ($, on) => {
  const { w, sets } = recording(on, { CLAUDE_CODE_TASK_LIST_ID: "" });
  await start($);
  expect(sets).toContainEqual(LIST_NAMED);
  expect(marker(w)).toMatchObject({ task_list: LIST_ID });
});

test("a refused set is logged and costs the session nothing else", async ($, on) => {
  const w = engine(on);
  on("env.set", () => ({ value: { deny: "managed settings hold another value" } }));
  await start($);
  expect(w.logs).toContain("omca could not set up the task list: managed settings hold another value");
  expect(w.files.has(MARKER)).toBe(true);
});

test("the marker follows the tools at each main turn, as they catch up after session start under claude -p", async ($, on) => {
  const w = engine(on);
  w.tools = ["Bash"];
  on("env.set", () => ({ value: {} }));
  await start($);
  expect(marker(w)).toMatchObject({ task_tools: false });
  w.tools = ["Bash", "TaskCreate", "TaskUpdate"];
  await w.clock.advance(1_000);
  await $.turn.start({ text: "go", turnId: "t-1" });
  expect(marker(w)).toMatchObject({ task_tools: true });
});

test("one task tool without the other counts as off", async ($, on) => {
  const w = engine(on);
  w.tools = ["Bash", "TaskCreate"];
  on("env.set", () => ({ value: {} }));
  await start($);
  expect(marker(w)).toMatchObject({ task_tools: false });
});
