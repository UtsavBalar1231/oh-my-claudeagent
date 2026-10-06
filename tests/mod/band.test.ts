import type { Args, On } from "claude-code";
import { type Engine, type EngineCall, expect, mock, type Mounted, test } from "claude-code/testing";
import { sha256Hex } from "../../src/core/sha256.ts";
import { displayWidth } from "../../src/core/ui-kit.ts";
import { hostSpelling } from "./world.ts";

const PLUGIN = "oh-my-claudeagent";
const SESSION = "00000000-0000-4000-8000-0000000000aa";
const ROOT = "/work";
const PLAN_NAME = "widget-rewrite";
const PLAN_PATH = `${ROOT}/plans/${PLAN_NAME}.md`;
const BOULDER = `${ROOT}/.omca/state/boulder.json`;
const STATUS = `${ROOT}/.omca/state/session/${SESSION}.json`;
const LEDGER = `${ROOT}/.omca/evidence/verification-evidence.json`;
const NOW_MS = 1_790_000_000_000;
const RAN_AT = NOW_MS / 1000 - 60;
const BEFORE_RUN_MS = (RAN_AT - 30) * 1000;
const AFTER_RUN_MS = (RAN_AT + 5) * 1000;
const SURFACES = ["terminal", "desktop"] as const;

const LOG_FILL = "Log evidence for `just test` with evidence_log";
const START_FILL = `/oh-my-claudeagent:start-work ${PLAN_PATH}`;

type Files = Map<string, { text: string; mtimeMs: number }>;
type Band = Mounted<"terminal" | "desktop", "AbovePrompt">;
type World = { fills: string[]; submits: string[]; logs: string[] };

function planText(done: number, total: number): string {
  const tasks = Array.from({ length: total }, (_, i) => `- [${i < done ? "x" : " "}] ${i + 1}. Port module ${i + 1}`);
  return `# Widget rewrite\n\n## TODOs\n\n${tasks.join("\n")}\n`;
}

const BOUND = JSON.stringify({
  plans: { [PLAN_NAME]: { active_plan: PLAN_PATH, started_at: "2026-10-02T10:00:00Z", session_ids: [SESSION] } },
  bindings: { [SESSION]: { plan_name: PLAN_NAME, bound_at: 1_789_990_000 } },
});

const statusFile = (command: string) =>
  JSON.stringify({
    session_id: SESSION,
    last_hook_at: RAN_AT,
    verification: { command, at: RAN_AT, exit_code: 0, evidence_logged: false },
  });

const ledger = (entries: readonly object[]) => JSON.stringify({ entries });
const final = (fields: object) => ({ type: "final_verification", command: "just ci", timestamp: "2026-10-02T12:00:00Z", exit_code: 0, ...fields });

function files(entries: Record<string, string | { text: string; mtimeMs: number }>): Files {
  return new Map(
    Object.entries(entries).map(([path, file]) => [
      path,
      typeof file === "string" ? { text: file, mtimeMs: BEFORE_RUN_MS } : file,
    ]),
  );
}

const bound = (done: number, total: number, extra: Record<string, string | { text: string; mtimeMs: number }> = {}) =>
  files({ [BOULDER]: BOUND, [PLAN_PATH]: planText(done, total), ...extra });

function world(on: On, disk: Files): World {
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
    return { value: e.as === "bytes" ? { base64: btoa(String.fromCharCode(...new TextEncoder().encode(file.text))) } : file.text };
  });
  on("fs.stat", (_$, e) => {
    const file = disk.get(spelled(e.path));
    if (file === undefined) throw new Error(`ENOENT: no such file or directory, stat '${spelled(e.path)}'`);
    return { value: { kind: "file", size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } };
  });
  on("prompt.fill", (_$, e) => (fills.push(e.text), { isFilled: true }));
  on("prompt.submit", (_$, e) => (submits.push(e.text), { text: e.text }));
  on("ui.log", (_$, e) => (logs.push(e.text), { value: undefined }));
  on("agent.spawn", (_$, e) => ({ model: "claude-sonnet-5-5", agentId: `agent-${e.tool_use_id}` }));
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ["engine band"] });
  });
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

const mount = ($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 120) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: "AbovePrompt",
    requestId: "band",
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 9 }, view: {} },
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

test("with no plan and no verification the band draws nothing and the engine's drawing stands", async ($, on) => {
  world(on, files({}));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await texts(band)).toEqual(["engine band"]);
  });
});

test("a bound plan with no verification shows the plan and no actions until a turn completes", async ($, on) => {
  world(on, bound(12, 46));
  await start($);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13");
    expect(await buttons(band)).toEqual([]);
  });
});

test("an unlogged verification shows as not logged and offers to log it before start-work", async ($, on) => {
  world(on, bound(12, 46, { [STATUS]: statusFile("just test"), [LEDGER]: ledger([]) }));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13 · ! just test evidence not logged");
    expect(await buttons(band)).toEqual([
      { key: "log-evidence", label: "Log evidence", hotkey: "1", plain: true },
      { key: "start-work", label: "Start work", hotkey: "2", plain: true },
    ]);
  });
});

test("a ledger written after the run counts as logged, whatever the status file says", async ($, on) => {
  world(on, bound(12, 46, { [STATUS]: statusFile("just test"), [LEDGER]: { text: ledger([]), mtimeMs: AFTER_RUN_MS } }));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13 · ✓ just test evidence logged");
    expect(await buttons(band)).toEqual([{ key: "start-work", label: "Start work", hotkey: "1", plain: true }]);
  });
});

test("with no plan an unlogged verification still draws the band, its only action to log it", async ($, on) => {
  world(on, files({ [STATUS]: statusFile("just test") }));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toBe("no plan bound · ! just test evidence not logged");
    expect(await buttons(band)).toEqual([{ key: "log-evidence", label: "Log evidence", hotkey: "1", plain: true }]);
  });
});

test("an unreadable registry draws a one-line reason in the band", async ($, on) => {
  const { logs } = world(on, files({ [BOULDER]: "{ not json" }));
  await start($);
  expect(logs.filter((line) => line.startsWith("band"))).toEqual([]);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toMatch(/^✗ Cannot read \.omca\/state\/boulder\.json: \S[^\n]*$/);
    expect(await buttons(band)).toEqual([]);
  });
});

test("a registry of another version binds no plan and draws no failure", async ($, on) => {
  const { logs } = world(on, files({ [BOULDER]: BOUND.replace("{", '{"version":2,'), [PLAN_PATH]: planText(3, 46) }));
  await start($);
  expect(logs.filter((line) => line.startsWith("band"))).toEqual([]);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).not.toMatch(/Cannot read/);
    expect(await buttons(band)).toEqual([]);
  });
});

test("a complete plan without a passing final verification offers to run it", async ($, on) => {
  world(on, bound(46, 46, { [LEDGER]: ledger([final({ exit_code: 1 })]) }));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await buttons(band)).toEqual([
      { key: "final-verification", label: "Run final verification", hotkey: "1", plain: true },
    ]);
  });
});

test("a malformed ledger entry beside the passing final verification does not hide it", async ($, on) => {
  const scoped = final({ plan_sha256: sha256Hex(new TextEncoder().encode(planText(46, 46))) });
  world(on, bound(46, 46, { [LEDGER]: ledger([{ type: "test" }, scoped]) }));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect((await buttons(band)).map((button) => button.key)).toEqual(["review"]);
  });
});

test("a ledger of another version on a complete plan names the failure", async ($, on) => {
  world(on, bound(46, 46, { [LEDGER]: JSON.stringify({ version: 2, entries: [] }) }));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toMatch(/^✗ Cannot read \.omca\/evidence\/verification-evidence\.json: its "version" is 2/);
  });
});

test("a final verification scoped to other plan bytes does not count", async ($, on) => {
  const stale = final({ plan_sha256: sha256Hex(new TextEncoder().encode(planText(45, 46))) });
  world(on, bound(46, 46, { [LEDGER]: ledger([stale]) }));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect((await buttons(band)).map((button) => button.key)).toEqual(["final-verification"]);
  });
});

test("a complete plan with a passing final verification for its current bytes offers the architect review", async ($, on) => {
  const scoped = final({ plan_sha256: sha256Hex(new TextEncoder().encode(planText(46, 46))) });
  world(on, bound(46, 46, { [LEDGER]: ledger([scoped]) }));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toBe("█████ 46/46");
    expect(await buttons(band)).toEqual([{ key: "review", label: "Review with the architect", hotkey: "1", plain: true }]);
  });
});

test("an unreadable ledger on a complete plan names the failure and still offers the final verification", async ($, on) => {
  const disk = bound(46, 46, { [LEDGER]: "{ not json" });
  world(on, disk);
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toMatch(
      /^✗ Cannot read \.omca\/evidence\/verification-evidence\.json: \S[^\n]*$/,
    );
    expect(await buttons(band)).toEqual([
      { key: "final-verification", label: "Run final verification", hotkey: "1", plain: true },
    ]);
  });

  const scoped = final({ plan_sha256: sha256Hex(new TextEncoder().encode(planText(46, 46))) });
  disk.set(LEDGER, { text: ledger([scoped]), mtimeMs: BEFORE_RUN_MS });
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toBe("█████ 46/46");
    expect(await buttons(band)).toEqual([{ key: "review", label: "Review with the architect", hotkey: "1", plain: true }]);
  });
});

test("an unlogged verification comes before the final verification", async ($, on) => {
  world(on, bound(46, 46, { [STATUS]: statusFile("just test"), [LEDGER]: ledger([]) }));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect((await buttons(band)).map((button) => [button.hotkey, button.key])).toEqual([
      ["1", "log-evidence"],
      ["2", "final-verification"],
    ]);
  });
});

const SPAWN = {
  prompt: "Port module 13.",
  description: "port module 13",
  subagentType: "oh-my-claudeagent:executor",
  provider: { plugin: PLUGIN, tier: "user" },
  parentModel: "claude-opus-5-5",
  background: true,
  fork: false,
} as const;

test("start-work is withheld while an agent is running", async ($, on) => {
  world(on, bound(12, 46));
  await start($);
  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_1" });
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13 · ◆ 1 running");
    expect(await buttons(band)).toEqual([]);
  });
});

test("the band counts the agents running now and drops the count when the last one ends", async ($, on) => {
  world(on, bound(12, 46));
  await start($);
  const band = await mount($, "terminal");
  expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13");

  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_1" });
  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_2" });
  await band.redraw();
  expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13 · ◆ 2 running");

  await turn($, "agent-toolu_1");
  await band.redraw();
  expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13 · ◆ 1 running");
  await turn($, "agent-toolu_2");
  await band.redraw();
  expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13");
});

test("the bar, the glyphs and the running count draw in their theme keys, the words plain or inactive", async ($, on) => {
  world(on, bound(12, 46, { [STATUS]: statusFile("just test") }));
  await start($);
  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_1" });
  await turn($);

  const band = await mount($, "terminal");
  const styled = (await band.findAll({ type: "Text" }))
    .slice(1)
    .map(({ text, props }) => [text, props["color"] ?? (props["bold"] === true ? "bold" : props["dimColor"] === true ? "dim" : "plain")]);
  expect(styled).toEqual([
    ["█", "success"],
    ["▎", "success"],
    ["███", "subtle"],
    [" 12/46", "inactive"],
    [" · ", "inactive"],
    ["next ", "inactive"],
    ["13 ", "bold"],
    ["Port module 13", "plain"],
    [" · ", "inactive"],
    ["! ", "warning"],
    ["just test", "plain"],
    [" evidence not logged", "plain"],
    [" · ", "inactive"],
    ["◆ ", "claude"],
    ["1 running", "plain"],
  ]);
});

test("proof counts draw only when the band carries them", async ($, on) => {
  const atoms = new Map<string, { value: unknown; version: number }>();
  let proof: object | undefined;
  on("state.get", (_$, e) => {
    const read = atoms.get(e.key) ?? { value: undefined, version: 0 };
    const { value } = read;
    const isBand = e.key === "band" && proof !== undefined && typeof value === "object" && value !== null;
    return { value: isBand ? { ...read, value: { ...value, proof } } : read };
  });
  on("state.set", (_$, e) => {
    const version = (atoms.get(e.key)?.version ?? 0) + 1;
    atoms.set(e.key, { value: e.value, version });
    return { value: { isSet: true, version } };
  });
  world(on, bound(12, 46));
  await start($);
  const band = await mount($, "terminal");
  expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13");

  proof = { proven: 52, unproven: 4, failed: 0 };
  await band.redraw();
  expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13 · ✓ 52 proven  ! 4 unproven");
  const colors = (await band.findAll({ type: "Text" })).filter(({ text }) => /^(?:[✓!✗] |\d+ \w+)$/.test(text)).map(({ text, props }) => [text, props["color"] ?? "plain"]);
  expect(colors).toEqual([
    ["✓ ", "success"],
    ["52 proven", "plain"],
    ["! ", "warning"],
    ["4 unproven", "plain"],
  ]);
});

test("the band counts each task's proof from its files' change times and the newest run since", async ($, on) => {
  const task = (n: number, file?: string) =>
    [`- [ ] ${n}. Port module ${n}`, ...(file === undefined ? [] : [`  - File: \`${file}\``])].join("\n");
  const plan = `# Widget rewrite\n\n## TODOs\n\n${[task(1, "src/a.ts"), task(2, "src/b.ts"), task(3, "src/gone.ts"), task(4)].join("\n")}\n`;
  const run = (at: number, exitCode: number) => ({
    type: "test",
    command: "just test",
    exit_code: exitCode,
    output_snippet: "",
    timestamp: new Date(at * 1000).toISOString(),
    verified_by: "executor",
  });
  const disk = files({
    [BOULDER]: BOUND,
    [PLAN_PATH]: plan,
    [`${ROOT}/src/a.ts`]: { text: "a", mtimeMs: BEFORE_RUN_MS },
    [`${ROOT}/src/b.ts`]: { text: "b", mtimeMs: AFTER_RUN_MS },
    [LEDGER]: ledger([run(RAN_AT, 0)]),
  });
  world(on, disk);
  await start($);
  const band = await mount($, "terminal");
  expect(await statusRow(band)).toBe("█████ 0/4 · next 1 Port module 1 · ✓ 1 proven  ! 1 unproven");

  disk.set(LEDGER, { text: ledger([run(RAN_AT, 0), run(RAN_AT + 10, 1)]), mtimeMs: AFTER_RUN_MS + 10_000 });
  await turn($);
  expect(await statusRow(band)).toBe("█████ 0/4 · next 1 Port module 1 · ✗ 2 failed");
});

test("a press fills the prompt with the exact text and never submits", async ($, on) => {
  const { fills, submits } = world(on, bound(12, 46, { [STATUS]: statusFile("just test") }));
  await start($);
  await turn($);

  const band = await mount($, "terminal");
  await band.press({ key: "log-evidence" });
  await band.press({ key: "start-work" });

  expect(fills).toEqual([LOG_FILL, START_FILL]);
  expect(submits).toEqual([]);
});

test("a sub-agent's turn refreshes the plan row and leaves the actions alone", async ($, on) => {
  const disk = bound(12, 46);
  world(on, disk);
  await start($);
  await turn($);
  const band = await mount($, "terminal");
  expect((await buttons(band)).map((button) => button.key)).toEqual(["start-work"]);

  disk.set(STATUS, { text: statusFile("just test"), mtimeMs: BEFORE_RUN_MS });
  await turn($, "agent-1");
  await band.redraw();
  expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13 · ! just test evidence not logged");
  expect((await buttons(band)).map((button) => button.key)).toEqual(["start-work"]);

  await turn($);
  await band.redraw();
  expect((await buttons(band)).map((button) => button.key)).toEqual(["log-evidence", "start-work"]);
});

test("typing into the prompt clears the actions; an edit that leaves it empty does not", async ($, on) => {
  world(on, bound(12, 46, { [STATUS]: statusFile("just test") }));
  await start($);
  await turn($);
  const band = await mount($, "terminal");

  await edit($, "", "");
  await band.redraw();
  expect((await buttons(band)).length).toBe(2);

  await edit($, "", "h");
  await band.redraw();
  expect(await buttons(band)).toEqual([]);
  expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13 · ! just test evidence not logged");
});

test("a bare digit that is a shown hotkey keeps the actions so the engine can press its Button", async ($, on) => {
  const { fills } = world(on, bound(12, 46, { [STATUS]: statusFile("just test") }));
  await start($);
  await turn($);
  const band = await mount($, "terminal");

  for (const [text, inputText] of [["", "1"], ["", "2"], ["", " 1 "]] as const) {
    await edit($, text, inputText);
    await band.redraw();
    expect((await buttons(band)).map((button) => button.hotkey), JSON.stringify(inputText)).toEqual(["1", "2"]);
  }
  await band.press({ key: "start-work" });
  expect(fills).toEqual([START_FILL]);
});

test("a digit with no shown Button, or a digit with more text, still clears the actions", async ($, on) => {
  world(on, bound(12, 46, { [STATUS]: statusFile("just test") }));
  await start($);
  await turn($);
  const band = await mount($, "terminal");

  await edit($, "", "3");
  await band.redraw();
  expect(await buttons(band)).toEqual([]);

  await turn($);
  await band.redraw();
  expect((await buttons(band)).length).toBe(2);
  await edit($, "1", "2");
  await band.redraw();
  expect(await buttons(band)).toEqual([]);
});

test("at 40 columns no Text in the band is wider than 40 cells", async ($, on) => {
  world(on, bound(12, 46, { [STATUS]: statusFile("bun test src servers statusline scripts opencode --coverage") }));
  await start($);
  await turn($);

  await onEachSurface(
    $,
    async (band) => {
      const rows = await texts(band);
      expect(rows).toEqual(["█▎███ 12/46 · next 13 Port module 13", "█", "▎", "███", " 12/46", " · ", "next ", "13 ", "Port module 13"]);
      for (const text of rows) expect(displayWidth(text), text).toBeLessThanOrEqual(40);
      for (const button of await buttons(band)) expect(displayWidth(`1: ${button.label}`)).toBeLessThanOrEqual(40);
    },
    40,
  );
});

test("at 80, 120 and 200 columns on both surfaces the rows read the same and end a space before the collapse mark", async ($, on) => {
  const long = "bun test src servers statusline scripts opencode --coverage --reporter=junit --timeout 20000";
  const disk = bound(12, 46, { [STATUS]: statusFile("just test") });
  world(on, disk);
  await start($);
  await turn($);

  for (const columns of [80, 120, 200]) {
    await onEachSurface(
      $,
      async (band) => {
        expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13 · ! just test evidence not logged");
        expect((await buttons(band)).map((button) => `${button.hotkey}: ${button.label}`)).toEqual([
          "1: Log evidence",
          "2: Start work",
        ]);
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
        expect(row).toMatch(/^█▎███ 12\/46 · next 13 Port module 13 · ! bun test src .*… evidence not logged$/);
        expect(displayWidth(row)).toBe(columns - 4);
      },
      columns,
    );
  }
  await onEachSurface(
    $,
    async (band) => expect(await statusRow(band)).toBe(`█▎███ 12/46 · next 13 Port module 13 · ! ${long} evidence not logged`),
    200,
  );
});

test("showBand false draws nothing, whatever the state", { options: { showBand: false } }, async ($, on) => {
  world(on, bound(12, 46, { [STATUS]: statusFile("just test") }));
  await start($);
  await turn($);

  await onEachSurface($, async (band) => {
    expect(await texts(band)).toEqual(["engine band"]);
  });
});

test("the band yields to a survey", async ($, on) => {
  world(on, bound(12, 46, { [STATUS]: statusFile("just test") }));
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

test("a burst of turn ends leaves the mounted band on the last state, drawn without any invalidate", async ($, on) => {
  const disk = bound(12, 46);
  world(on, disk);
  await start($);
  const band = await mount($, "terminal");
  expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13");

  for (let n = 0; n < 8; n++) {
    disk.set(STATUS, { text: statusFile(`just test ${n}`), mtimeMs: BEFORE_RUN_MS });
    await turn($, n % 2 === 0 ? undefined : `agent-${n}`);
  }

  expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13 · ! just test 7 evidence not logged");
  expect((await buttons(band)).map((button) => button.key)).toEqual(["log-evidence", "start-work"]);

  disk.set(STATUS, { text: statusFile("just test again"), mtimeMs: BEFORE_RUN_MS });
  await turn($);
  expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13 · ! just test again evidence not logged");
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
  world(on, bound(12, 46));
  await start($);
  await turn($);
  const band = await mount($, "terminal");
  const before = { writes: bandWrites, drawn: [await texts(band), await buttons(band)] };

  await turn($);
  await turn($, "agent-1");

  expect(bandWrites).toBe(before.writes);
  expect([await texts(band), await buttons(band)]).toEqual(before.drawn);
});

test("running agents show on the band with no plan bound, without the no-plan text", async ($, on) => {
  world(on, files({}));
  await start($);
  await turn($);
  const band = await mount($, "terminal");
  expect(await texts(band)).toEqual(["engine band"]);

  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_1" });
  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_2" });
  await band.redraw();
  expect(await statusRow(band)).toBe("◆ 2 running");

  await turn($, "agent-toolu_1");
  await turn($, "agent-toolu_2");
  await band.redraw();
  expect(await texts(band)).toEqual(["engine band"]);
});

test("an idle teammate is not counted among the agents running", async ($, on) => {
  world(on, bound(12, 46));
  await start($);
  const band = await mount($, "terminal");
  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_1" });
  await $.agent.spawn({ ...SPAWN, tool_use_id: "toolu_2", isTeammate: true });
  await turn($, "agent-toolu_2");
  await band.redraw();
  expect(await statusRow(band)).toBe("█▎███ 12/46 · next 13 Port module 13 · ◆ 1 running");
});
