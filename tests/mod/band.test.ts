import type { Args, Elements, On, RenderElement } from "claude-code";
import { type Engine, type EngineCall, expect, mock, type Mounted, test } from "claude-code/testing";
import { displayWidth } from "../../src/core/ui-kit.ts";
import { hostSpelling } from "./world.ts";

const PLUGIN = "oh-my-claudeagent";
const SESSION = "00000000-0000-4000-8000-0000000000aa";
const ROOT = "/work";
const HOME = "/home/u";
const TASK = `${HOME}/.claude/tasks/run-list/1.json`;
const STATUS = `${ROOT}/.omca/state/session/${SESSION}.json`;
const NOW_MS = 1_790_000_000_000;
const RAN_AT = NOW_MS / 1000 - 60;
const BEFORE_RUN_MS = (RAN_AT - 30) * 1000;
const SURFACES = ["terminal", "desktop"] as const;

const TASK_FILL = "/tasklist";

type Files = Map<string, { text: string; mtimeMs: number }>;
type Band = Mounted<"terminal" | "desktop", "AbovePrompt">;
type World = { fills: string[]; submits: string[]; logs: string[] };
type Kit = Elements[keyof Elements];

const engineBand = ({ Text }: Kit): RenderElement => Text({ children: ["engine band"] });

const statusFile = (command: string, isLogged = false) =>
  JSON.stringify({
    session_id: SESSION,
    last_hook_at: RAN_AT,
    verification: { command, at: RAN_AT, exit_code: 0, evidence_logged: isLogged },
  });

function files(entries: Record<string, string | { text: string; mtimeMs: number }>): Files {
  return new Map(
    Object.entries(entries).map(([path, file]) => [
      path,
      typeof file === "string" ? { text: file, mtimeMs: BEFORE_RUN_MS } : file,
    ]),
  );
}

function world(on: On, disk: Files, beneath: (kit: Kit) => RenderElement = engineBand): World {
  const fills: string[] = [];
  const submits: string[] = [];
  const logs: string[] = [];
  mock.clock(on, { now: NOW_MS });
  mock.env(on, { OMCA_GLYPHS: "unicode", HOME: HOME, CLAUDE_CODE_TASK_LIST_ID: "run-list" });
  on("session.id", () => ({ value: SESSION }));
  on("session.root", () => ({ value: ROOT }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("prompt.edit", (_$, e) => {
    const text = `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`;
    return { text, cursor: e.start + e.inputText.length };
  });
  const spelled = (path: string) => hostSpelling(path, "linux");
  on("fs.exists", (_$, e) => ({ value: [...disk.keys()].some((path) => path === spelled(e.path) || path.startsWith(`${spelled(e.path)}/`)) }));
  on("fs.list", (_$, e) => {
    const dir = spelled(e.path);
    const entries = [...disk.entries()]
      .filter(([path]) => path.startsWith(`${dir}/`))
      .map(([path, file]) => ({ name: path.slice(dir.length + 1), kind: "file" as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false }));
    return { value: entries };
  });
  on("fs.read", (_$, e) => {
    const file = disk.get(spelled(e.path));
    if (file === undefined) throw new Error(`ENOENT: no such file or directory, open '${spelled(e.path)}'`);
    return { value: file.text };
  });
  on("fs.stat", (_$, e) => {
    const file = disk.get(spelled(e.path));
    if (file === undefined) throw new Error(`ENOENT: no such file or directory, stat '${spelled(e.path)}'`);
    return { value: { kind: "file", size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } };
  });
  on("prompt.change", (_$, e) => ({ text: e.text }));
  on("prompt.fill", (_$, e) => (fills.push(e.text), { isFilled: true }));
  on("prompt.submit", (_$, e) => (submits.push(e.text), { text: e.text }));
  on("ui.log", (_$, e) => (logs.push(e.text), { value: undefined }));
  on("agent.spawn", (_$, e) => ({ model: "claude-sonnet-5-5", agentId: `agent-${e.tool_use_id}` }));
  on("ui.render", ($, e) => beneath($.ui.resolve(e)));
  return { fills, submits, logs };
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });

const turn = ($: Engine, agentId?: string) =>
  $.turn.complete({
    answer: "done",
    durationMs: 10,
    isAborted: false,
    turnId: "t-1",
    reason: "answer",
    ...(agentId !== undefined && { agentId }),
  });

const edit = ($: Engine, text: string, inputText: string): Promise<unknown> => {
  const e: Args<"prompt.edit"> = {
    origin: { kind: "composer" },
    text,
    cursor: text.length,
    start: text.length,
    end: text.length,
    inputText,
  };
  const prompt: { fill: unknown; edit?: EngineCall<"prompt.edit"> } = $.prompt;
  if (prompt.edit === undefined) throw new Error("this engine offers no $.prompt.edit");
  return prompt.edit(e);
};

const change = ($: Engine, text: string, origin: Args<"prompt.change">["origin"]): Promise<unknown> => {
  const prompt: { fill: unknown; change?: EngineCall<"prompt.change"> } = $.prompt;
  if (prompt.change === undefined) throw new Error("this engine offers no $.prompt.change");
  return prompt.change({ text, cursor: text.length, origin });
};

const mount = ($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 120, view: { agentId?: string } = {}) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: "AbovePrompt",
    requestId: "band",
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 9 }, view },
  });

async function texts(band: Band): Promise<string[]> {
  return (await band.findAll({ type: "Text" })).map((element) => element.text);
}

async function buttons(band: Band): Promise<{ key: string | undefined; label: unknown; hotkey: unknown; plain: unknown }[]> {
  return (await band.findAll({ type: "Button" })).map(({ key, props }) => ({
    key,
    label: props["label"],
    hotkey: props["hotkey"],
    plain: props["plain"],
  }));
}

async function onEachSurface($: Engine, check: (band: Band) => Promise<void>, bodyColumns = 120): Promise<void> {
  for (const surface of SURFACES) {
    const band = await mount($, surface, bodyColumns);
    await check(band);
    await band.unmount();
  }
}

const TASK_BUTTON = { key: "task-list", label: "Task list", hotkey: "1", plain: true };
const UNLOGGED = () => files({ [STATUS]: statusFile("just test") });

const RUN_TASK = JSON.stringify({ id: "1", subject: "a", description: "", activeForm: "", status: "pending", blocks: [], blockedBy: [], metadata: { run: "widget" } });
const withRun = (disk: Files): Files => disk.set(TASK, { text: RUN_TASK, mtimeMs: BEFORE_RUN_MS });

// The band's actions come from a turn that ends with a run open.
async function runningWorld($: Engine, on: On, beneath?: (kit: Kit) => RenderElement): Promise<World> {
  const w = world(on, withRun(files({})), beneath);
  await start($);
  await turn($);
  return w;
}

const SPAWN = {
  prompt: "Port module 13.",
  description: "port module 13",
  subagentType: "oh-my-claudeagent:executor",
  provider: { plugin: PLUGIN, tier: "user" },
  parentModel: "claude-opus-5-5",
  background: true,
  fork: false,
} as const;

test("with no run and no error the band draws nothing and the engine's drawing stands", async ($, on) => {
  world(on, files({}));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await texts(band)).toEqual(["engine band"]);
  });
});

test("a verification, logged or not, draws no row and offers no button", async ($, on) => {
  const disk = UNLOGGED();
  world(on, disk);
  await start($);
  await turn($);

  for (const isLogged of [false, true]) {
    disk.set(STATUS, { text: statusFile("just test", isLogged), mtimeMs: BEFORE_RUN_MS });
    await turn($);
    await onEachSurface($, async (band) => {
      expect(await texts(band)).toEqual(["engine band"]);
      expect(await buttons(band)).toEqual([]);
    });
  }
});

test("a status file that is not JSON draws a one-line reason in the band", async ($, on) => {
  const { logs } = world(on, files({ [STATUS]: "{ not json" }));
  await start($);
  expect(logs.filter((line) => line.startsWith("band"))).toEqual([]);

  await onEachSurface($, async (band) => {
    expect((await texts(band))[0]).toMatch(/^✗ Cannot read the session status file: \S[^\n]*$/);
    expect(await buttons(band)).toEqual([]);
  });
});

test("the band reads no plan file: a registry and a plan file leave it as it was", async ($, on) => {
  const w = world(on, files({ [`${ROOT}/.omca/state/boulder.json`]: "{ not json", [`${ROOT}/plans/widget.md`]: "- [ ] 1. a\n" }));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await texts(band)).toEqual(["engine band"]);
  });
  expect(w.logs.filter((line) => line.startsWith("band"))).toEqual([]);
});

test("the error glyph draws in its theme key, the words plain", async ($, on) => {
  world(on, files({ [STATUS]: "{ not json" }));
  await start($);

  const band = await mount($, "terminal");
  const styled = (await band.findAll({ type: "Text" })).map(({ text, props }) => [text.slice(0, 6), props["color"] ?? "plain"]);
  expect(styled).toContainEqual(["✗ ", "error"]);
  expect(styled).toContainEqual(["Cannot", "plain"]);
});

test("an open run offers the task list once a turn completes, not before", async ($, on) => {
  world(on, withRun(files({})));
  await start($);

  await onEachSurface($, async (band) => expect(await buttons(band)).toEqual([]));
  await turn($);
  await onEachSurface($, async (band) => expect(await buttons(band)).toEqual([TASK_BUTTON]));
});

test("running agents leave the band as it was, since the engine lists them under the prompt", async ($, on) => {
  await runningWorld($, on);
  const band = await mount($, "terminal");
  expect(await buttons(band)).toEqual([TASK_BUTTON]);

  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_1" });
  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_2" });
  await band.redraw();
  expect(await buttons(band)).toEqual([TASK_BUTTON]);
});

test("a press fills the prompt with the exact text and never submits", async ($, on) => {
  const { fills, submits } = await runningWorld($, on);

  const band = await mount($, "terminal");
  await band.press({ key: "task-list" });

  expect(fills).toEqual([TASK_FILL]);
  expect(submits).toEqual([]);
});

test("a sub-agent's turn leaves the actions alone", async ($, on) => {
  const disk = files({});
  world(on, disk);
  await start($);
  await turn($);
  const band = await mount($, "terminal");
  expect(await buttons(band)).toEqual([]);

  withRun(disk);
  await turn($, "agent-1");
  await band.redraw();
  expect(await buttons(band)).toEqual([]);

  await turn($);
  await band.redraw();
  expect((await buttons(band)).map((button) => button.key)).toEqual(["task-list"]);
});

test("typing into the prompt clears the actions; an edit that leaves it empty does not", async ($, on) => {
  await runningWorld($, on);
  const band = await mount($, "terminal");

  await edit($, "", "");
  await band.redraw();
  expect((await buttons(band)).length).toBe(1);

  await edit($, "", "h");
  await band.redraw();
  expect(await buttons(band)).toEqual([]);
});

test("a bare digit that is a shown hotkey keeps the actions so the engine can press its Button", async ($, on) => {
  const { fills } = await runningWorld($, on);
  const band = await mount($, "terminal");

  for (const [text, inputText] of [["", "1"], ["", " 1 "]] as const) {
    await edit($, text, inputText);
    await band.redraw();
    expect((await buttons(band)).map((button) => button.hotkey), JSON.stringify(inputText)).toEqual(["1"]);
  }
  await band.press({ key: "task-list" });
  expect(fills).toEqual([TASK_FILL]);
});

test("a digit with no shown Button, or a digit with more text, still clears the actions", async ($, on) => {
  await runningWorld($, on);
  const band = await mount($, "terminal");

  await edit($, "", "2");
  await band.redraw();
  expect(await buttons(band)).toEqual([]);

  await turn($);
  await band.redraw();
  expect((await buttons(band)).length).toBe(1);
  await edit($, "1", "2");
  await band.redraw();
  expect(await buttons(band)).toEqual([]);
});

test("a prompt filled from history, an undo, the engine or another plugin clears the actions", async ($, on) => {
  await runningWorld($, on);
  const band = await mount($, "terminal");

  for (const origin of [{ kind: "history" }, { kind: "undo" }, { kind: "engine" }, { kind: "plugin", name: "other-plugin" }] as const) {
    await turn($);
    await band.redraw();
    expect((await buttons(band)).length, origin.kind).toBe(1);
    await change($, "earlier draft", origin);
    await band.redraw();
    expect(await buttons(band), origin.kind).toEqual([]);
  }
});

test("while an agent's transcript is in view the band holds its actions, and typing there keeps them for the main view", async ($, on) => {
  await runningWorld($, on);
  const main = await mount($, "terminal");
  expect((await buttons(main)).length).toBe(1);
  await main.unmount();
  const agent = await mount($, "terminal", 120, { agentId: "a1" });
  expect(await buttons(agent)).toEqual([]);

  await edit($, "x", "x");
  await change($, "earlier draft", { kind: "history" });
  await agent.unmount();
  const back = await mount($, "terminal");
  expect((await buttons(back)).length).toBe(1);
});

test("the band's own fill, an emptied prompt and a lone shown hotkey keep the actions", async ($, on) => {
  await runningWorld($, on);
  const band = await mount($, "terminal");

  await change($, TASK_FILL, { kind: "plugin", name: "oh-my-claudeagent" });
  await change($, "", { kind: "clear" });
  await change($, "1", { kind: "engine" });
  await band.redraw();
  expect((await buttons(band)).map((button) => button.hotkey)).toEqual(["1"]);
});

test("at 40 columns no Text in the band is wider than 40 cells", async ($, on) => {
  world(on, withRun(files({ [STATUS]: `{ ${"x".repeat(100)}` })));
  await start($);
  await turn($);

  await onEachSurface(
    $,
    async (band) => {
      const rows = await texts(band);
      expect(rows[0]).toMatch(/^✗ Cannot read .*…$/);
      for (const text of rows) expect(displayWidth(text), text).toBeLessThanOrEqual(40);
      for (const button of await buttons(band)) expect(displayWidth(`1: ${button.label}`)).toBeLessThanOrEqual(40);
    },
    40,
  );
});

test("at 80, 120 and 200 columns on both surfaces the error row ends a space before the collapse mark", async ($, on) => {
  world(on, withRun(files({ [STATUS]: `{ ${"x".repeat(300)}` })));
  await start($);
  await turn($);

  for (const columns of [80, 120, 200]) {
    await onEachSurface(
      $,
      async (band) => {
        expect(displayWidth((await texts(band))[0] ?? "")).toBeLessThanOrEqual(columns - 4);
        expect((await buttons(band)).map((button) => `${button.hotkey}: ${button.label}`)).toEqual(["1: Task list"]);
      },
      columns,
    );
  }
});

test("showBand false draws nothing, whatever the state", { options: { showBand: false } }, async ($, on) => {
  await runningWorld($, on);

  await onEachSurface($, async (band) => {
    expect(await texts(band)).toEqual(["engine band"]);
  });
});

test("the band yields to a survey", async ($, on) => {
  await runningWorld($, on);

  for (const surface of SURFACES) {
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: "AbovePrompt",
      props: { hasSurvey: true, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
    });
    expect(await texts(band)).toEqual(["engine band"]);
    await band.unmount();
  }
});

test("another mod's band stays beneath the rows, in a Box with no size, position, display or overflow, its Button still pressable", async ($, on) => {
  const presses: string[] = [];
  const otherBand = ({ Box, Button, Text }: Kit): RenderElement =>
    Box({
      key: "other-band",
      children: [Text({ children: ["other mod's band"] }), Button({ key: "other-press", label: "Theme", onPress: () => void presses.push("other-press") })],
    });
  await runningWorld($, on, otherBand);

  await onEachSurface($, async (band) => {
    expect((await texts(band)).at(-1)).toBe("other mod's band");
    expect((await buttons(band)).map((button) => button.key)).toEqual(["task-list", "other-press"]);
    const holder = await band.find({ key: "omca-band" });
    expect(holder?.type).toBe("Box");
    const layout = ["width", "height", "minWidth", "minHeight", "position", "top", "left", "right", "bottom", "display", "overflow"];
    expect(Object.keys(holder?.props ?? {}).filter((prop) => layout.includes(prop))).toEqual([]);
  });

  const band = await mount($, "terminal");
  await band.press({ key: "other-press", plugin: "test" });
  expect(presses).toEqual(["other-press"]);
});

test("a turn that changes nothing writes nothing to the band", async ($, on) => {
  const atoms = new Map<string, { value: unknown; version: number }>();
  let bandWrites = 0;
  on("state.get", (_$, e) => ({ value: atoms.get(e.key) ?? { value: undefined, version: 0 } }));
  on("state.set", (_$, e) => {
    if (e.key === "band") bandWrites += 1;
    const version = (atoms.get(e.key)?.version ?? 0) + 1;
    atoms.set(e.key, { value: e.value, version });
    return { value: { isSet: true, version } };
  });
  world(on, files({ [STATUS]: "{ not json" }));
  await start($);
  await turn($);
  const band = await mount($, "terminal");
  const before = { writes: bandWrites, drawn: [await texts(band), await buttons(band)] };

  await turn($);
  await turn($, "agent-1");

  expect(bandWrites).toBe(before.writes);
  expect([await texts(band), await buttons(band)]).toEqual(before.drawn);
});

test("with no run, running agents draw no band and the engine's drawing stands", async ($, on) => {
  world(on, files({}));
  await start($);
  await turn($);
  const band = await mount($, "terminal");
  expect(await texts(band)).toEqual(["engine band"]);

  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_1" });
  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_2" });
  await band.redraw();
  expect(await texts(band)).toEqual(["engine band"]);
});
