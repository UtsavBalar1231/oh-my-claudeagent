import type { Args, Elements, On, RenderElement } from "claude-code";
import { type Engine, type EngineCall, expect, mock, type Mounted, test } from "claude-code/testing";
import { displayWidth } from "../../src/core/ui-kit.ts";
import { hostSpelling } from "./world.ts";

const PLUGIN = "oh-my-claudeagent";
const SESSION = "00000000-0000-4000-8000-0000000000aa";
const ROOT = "/work";
const STATUS = `${ROOT}/.omca/state/session/${SESSION}.json`;
const LEDGER = `${ROOT}/.omca/evidence/verification-evidence.json`;
const NOW_MS = 1_790_000_000_000;
const RAN_AT = NOW_MS / 1000 - 60;
const BEFORE_RUN_MS = (RAN_AT - 30) * 1000;
const AFTER_RUN_MS = (RAN_AT + 5) * 1000;
const SURFACES = ["terminal", "desktop"] as const;

const LOG_FILL = "Log evidence for `just test` with evidence_log";

type Files = Map<string, { text: string; mtimeMs: number }>;
type Band = Mounted<"terminal" | "desktop", "AbovePrompt">;
type World = { fills: string[]; submits: string[]; logs: string[] };
type Kit = Elements[keyof Elements];

const engineBand = ({ Text }: Kit): RenderElement => Text({ children: ["engine band"] });

const statusFile = (command: string) =>
  JSON.stringify({
    session_id: SESSION,
    last_hook_at: RAN_AT,
    verification: { command, at: RAN_AT, exit_code: 0, evidence_logged: false },
  });

const ledger = (entries: readonly object[]) => JSON.stringify({ entries });

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
  mock.env(on, { OMCA_GLYPHS: "unicode" });
  on("session.id", () => ({ value: SESSION }));
  on("session.root", () => ({ value: ROOT }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("prompt.edit", (_$, e) => {
    const text = `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`;
    return { text, cursor: e.start + e.inputText.length };
  });
  const spelled = (path: string) => hostSpelling(path, "linux");
  on("fs.exists", (_$, e) => ({ value: disk.has(spelled(e.path)) }));
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
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 9 }, view },
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

const statusRow = async (band: Band): Promise<string | undefined> => (await texts(band))[0];

async function onEachSurface($: Engine, check: (band: Band) => Promise<void>, bodyColumns = 120): Promise<void> {
  for (const surface of SURFACES) {
    const band = await mount($, surface, bodyColumns);
    await check(band);
    await band.unmount();
  }
}

const UNLOGGED_ROW = "! just test evidence not logged";
const LOG_BUTTON = { key: "log-evidence", label: "Log evidence", hotkey: "1", plain: true };
const UNLOGGED = () => files({ [STATUS]: statusFile("just test"), [LEDGER]: ledger([]) });

const SPAWN = {
  prompt: "Port module 13.",
  description: "port module 13",
  subagentType: "oh-my-claudeagent:executor",
  provider: { plugin: PLUGIN, tier: "user" },
  parentModel: "claude-opus-5-5",
  background: true,
  fork: false,
} as const;

test("with no verification the band draws nothing and the engine's drawing stands", async ($, on) => {
  world(on, files({}));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await texts(band)).toEqual(["engine band"]);
  });
});

test("a verification shows at session start, and its action only once a turn completes", async ($, on) => {
  world(on, UNLOGGED());
  await start($);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toBe(UNLOGGED_ROW);
    expect(await buttons(band)).toEqual([]);
  });
});

test("an unlogged verification shows as not logged and offers to log it", async ($, on) => {
  world(on, UNLOGGED());
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toBe(UNLOGGED_ROW);
    expect(await buttons(band)).toEqual([LOG_BUTTON]);
  });
});

test("a ledger written after the run counts as logged, whatever the status file says, and offers nothing", async ($, on) => {
  world(on, files({ [STATUS]: statusFile("just test"), [LEDGER]: { text: ledger([]), mtimeMs: AFTER_RUN_MS } }));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toBe("✓ just test evidence logged");
    expect(await buttons(band)).toEqual([]);
  });
});

test("a status file that is not JSON draws a one-line reason in the band", async ($, on) => {
  const { logs } = world(on, files({ [STATUS]: "{ not json" }));
  await start($);
  expect(logs.filter((line) => line.startsWith("band"))).toEqual([]);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toMatch(/^✗ Cannot read the session status file: \S[^\n]*$/);
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

test("the glyph draws in its theme key, the words plain or inactive", async ($, on) => {
  world(on, files({ [STATUS]: statusFile("just test") }));
  await start($);
  await turn($);

  const band = await mount($, "terminal");
  const styled = (await band.findAll({ type: "Text" }))
    .slice(1)
    .map(({ text, props }) => [text, props["color"] ?? (props["weight"] === "semibold" ? "bold" : props["dimColor"] === true ? "dim" : "plain")]);
  expect(styled).toEqual([
    ["! ", "warning"],
    ["just test", "plain"],
    [" evidence not logged", "plain"],
    ["engine band", "plain"],
  ]);
});

test("running agents leave the band as it was, since the engine lists them under the prompt", async ($, on) => {
  world(on, UNLOGGED());
  await start($);
  await turn($);
  const band = await mount($, "terminal");
  expect(await statusRow(band)).toBe(UNLOGGED_ROW);

  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_1" });
  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_2" });
  await band.redraw();
  expect(await statusRow(band)).toBe(UNLOGGED_ROW);
  expect(await buttons(band)).toEqual([LOG_BUTTON]);
});

test("a press fills the prompt with the exact text and never submits", async ($, on) => {
  const { fills, submits } = world(on, UNLOGGED());
  await start($);
  await turn($);

  const band = await mount($, "terminal");
  await band.press({ key: "log-evidence" });

  expect(fills).toEqual([LOG_FILL]);
  expect(submits).toEqual([]);
});

test("a sub-agent's turn refreshes the status row and leaves the actions alone", async ($, on) => {
  const disk = files({});
  world(on, disk);
  await start($);
  await turn($);
  const band = await mount($, "terminal");
  expect(await buttons(band)).toEqual([]);

  disk.set(STATUS, { text: statusFile("just test"), mtimeMs: BEFORE_RUN_MS });
  await turn($, "agent-1");
  await band.redraw();
  expect(await statusRow(band)).toBe(UNLOGGED_ROW);
  expect(await buttons(band)).toEqual([]);

  await turn($);
  await band.redraw();
  expect((await buttons(band)).map((button) => button.key)).toEqual(["log-evidence"]);
});

test("typing into the prompt clears the actions; an edit that leaves it empty does not", async ($, on) => {
  world(on, UNLOGGED());
  await start($);
  await turn($);
  const band = await mount($, "terminal");

  await edit($, "", "");
  await band.redraw();
  expect((await buttons(band)).length).toBe(1);

  await edit($, "", "h");
  await band.redraw();
  expect(await buttons(band)).toEqual([]);
  expect(await statusRow(band)).toBe(UNLOGGED_ROW);
});

test("a bare digit that is a shown hotkey keeps the actions so the engine can press its Button", async ($, on) => {
  const { fills } = world(on, UNLOGGED());
  await start($);
  await turn($);
  const band = await mount($, "terminal");

  for (const [text, inputText] of [["", "1"], ["", " 1 "]] as const) {
    await edit($, text, inputText);
    await band.redraw();
    expect((await buttons(band)).map((button) => button.hotkey), JSON.stringify(inputText)).toEqual(["1"]);
  }
  await band.press({ key: "log-evidence" });
  expect(fills).toEqual([LOG_FILL]);
});

test("a digit with no shown Button, or a digit with more text, still clears the actions", async ($, on) => {
  world(on, UNLOGGED());
  await start($);
  await turn($);
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
  world(on, UNLOGGED());
  await start($);
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
  world(on, UNLOGGED());
  await start($);
  await turn($);
  const main = await mount($, "terminal");
  expect((await buttons(main)).length).toBe(1);
  await main.unmount();
  const agent = await mount($, "terminal", 120, { agentId: "a1" });
  expect(await buttons(agent)).toEqual([]);
  expect(await statusRow(agent)).toBeDefined();

  await edit($, "x", "x");
  await change($, "earlier draft", { kind: "history" });
  await agent.unmount();
  const back = await mount($, "terminal");
  expect((await buttons(back)).length).toBe(1);
});

test("the band's own fill, an emptied prompt and a lone shown hotkey keep the actions", async ($, on) => {
  world(on, UNLOGGED());
  await start($);
  await turn($);
  const band = await mount($, "terminal");

  await change($, LOG_FILL, { kind: "plugin", name: "oh-my-claudeagent" });
  await change($, "", { kind: "clear" });
  await change($, "1", { kind: "engine" });
  await band.redraw();
  expect((await buttons(band)).map((button) => button.hotkey)).toEqual(["1"]);
});

test("at 40 columns no Text in the band is wider than 40 cells", async ($, on) => {
  world(on, files({ [STATUS]: statusFile("bun test src servers statusline scripts opencode --coverage") }));
  await start($);
  await turn($);

  await onEachSurface(
    $,
    async (band) => {
      const rows = await texts(band);
      expect(rows[0]).toMatch(/^! bun test .*… evidence not logged$/);
      for (const text of rows) expect(displayWidth(text), text).toBeLessThanOrEqual(40);
      for (const button of await buttons(band)) expect(displayWidth(`1: ${button.label}`)).toBeLessThanOrEqual(40);
    },
    40,
  );
});

test("at 80, 120 and 200 columns on both surfaces the rows read the same and end a space before the collapse mark", async ($, on) => {
  const long = `bun test src ${"servers/".repeat(15)}`;
  const disk = UNLOGGED();
  world(on, disk);
  await start($);
  await turn($);

  for (const columns of [80, 120, 200]) {
    await onEachSurface(
      $,
      async (band) => {
        expect(await statusRow(band)).toBe(UNLOGGED_ROW);
        expect((await buttons(band)).map((button) => `${button.hotkey}: ${button.label}`)).toEqual(["1: Log evidence"]);
      },
      columns,
    );
  }

  disk.set(STATUS, { text: statusFile(long), mtimeMs: BEFORE_RUN_MS });
  await turn($);
  for (const columns of [80, 120]) {
    await onEachSurface(
      $,
      async (band) => {
        const row = (await statusRow(band)) ?? "";
        expect(row).toMatch(/^! bun test src .*… evidence not logged$/);
        expect(displayWidth(row)).toBe(columns - 4);
      },
      columns,
    );
  }
  await onEachSurface($, async (band) => expect(await statusRow(band)).toBe(`! ${long} evidence not logged`), 200);
});

test("too narrow for the full wording the row keeps the command and says not logged", async ($, on) => {
  world(on, UNLOGGED());
  await start($);
  await turn($);

  await onEachSurface($, async (band) => expect(await statusRow(band)).toBe("! just test not logged"), 30);
});

test("showBand false draws nothing, whatever the state", { options: { showBand: false } }, async ($, on) => {
  world(on, UNLOGGED());
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await texts(band)).toEqual(["engine band"]);
  });
});

test("the band yields to a survey", async ($, on) => {
  world(on, UNLOGGED());
  await start($);
  await turn($);

  for (const surface of SURFACES) {
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: "AbovePrompt",
      props: { hasSurvey: true, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
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
  world(on, UNLOGGED(), otherBand);
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    const rows = await texts(band);
    expect(rows[0]).toBe(UNLOGGED_ROW);
    expect(rows.at(-1)).toBe("other mod's band");
    expect((await buttons(band)).map((button) => button.key)).toEqual(["log-evidence", "other-press"]);
    const holder = await band.find({ key: "omca-band" });
    expect(holder?.type).toBe("Box");
    const layout = ["width", "height", "minWidth", "minHeight", "position", "top", "left", "right", "bottom", "display", "overflow"];
    expect(Object.keys(holder?.props ?? {}).filter((prop) => layout.includes(prop))).toEqual([]);
  });

  const band = await mount($, "terminal");
  await band.press({ key: "other-press", plugin: "test" });
  expect(presses).toEqual(["other-press"]);
});

test("a burst of turn ends leaves the mounted band on the last state, drawn without any invalidate", async ($, on) => {
  const disk = UNLOGGED();
  world(on, disk);
  await start($);
  const band = await mount($, "terminal");
  expect(await statusRow(band)).toBe(UNLOGGED_ROW);

  for (let n = 0; n < 8; n++) {
    disk.set(STATUS, { text: statusFile(`just test ${n}`), mtimeMs: BEFORE_RUN_MS + n });
    await turn($, n % 2 === 0 ? undefined : `agent-${n}`);
  }

  expect(await statusRow(band)).toBe("! just test 7 evidence not logged");
  expect((await buttons(band)).map((button) => button.key)).toEqual(["log-evidence"]);

  disk.set(STATUS, { text: statusFile("just test again"), mtimeMs: BEFORE_RUN_MS });
  await turn($);
  expect(await statusRow(band)).toBe("! just test again evidence not logged");
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
  world(on, UNLOGGED());
  await start($);
  await turn($);
  const band = await mount($, "terminal");
  const before = { writes: bandWrites, drawn: [await texts(band), await buttons(band)] };

  await turn($);
  await turn($, "agent-1");

  expect(bandWrites).toBe(before.writes);
  expect([await texts(band), await buttons(band)]).toEqual(before.drawn);
});

test("with no verification, running agents draw no band and the engine's drawing stands", async ($, on) => {
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
