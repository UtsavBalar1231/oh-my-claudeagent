import { describe, expect, test } from "bun:test";
import {
  addRefreshInterval,
  type Check,
  doctorChecks,
  type Inputs,
  removeSetupBlock,
  setupBlock,
  unifiedDiff,
} from "./doctor-checks.ts";

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const STATUS_LINE = { type: "command", command: "omca-statusline" };
const USER_SETTINGS = `{\n  "statusLine": {\n    "type": "command",\n    "command": "omca-statusline"\n  }\n}\n`;

const BASE: Inputs = {
  modVersion: "3.0.0",
  engineVersion: "2.1.287",
  bunVersion: "1.4.2",
  astGrep: { name: "ast-grep", version: "0.39.0" },
  hook: { kind: "seen", lastHookAt: NOW / 1000 - 30 },
  now: NOW,
  settings: {
    pluginConfigs: { "oh-my-claudeagent@omca": { options: { showBand: false, guardMode: "deny" } } },
    advisorModel: "fable",
    statusLine: { ...STATUS_LINE, refreshInterval: 5 },
  },
  env: {},
  userSettings: null,
  claudeMd: { path: "~/.claude/CLAUDE.md", text: "# Mine\n" },
};

const run = (change: Partial<Inputs>, id: string): Omit<Check, "id" | "label"> | undefined => {
  const found = doctorChecks({ ...BASE, ...change }).find((check) => check.id === id);
  if (found === undefined) return undefined;
  const { id: _id, label: _label, ...rest } = found;
  return rest;
};

test("the checks come in a fixed order with their labels, all ok or info on a healthy setup", () => {
  expect(doctorChecks(BASE).map(({ id, label, level }) => [id, label, level])).toEqual([
    ["mod", "OMCA", "ok"],
    ["engine", "Claude Code", "ok"],
    ["bun", "bun", "ok"],
    ["server", "omca server", "ok"],
    ["ast-grep", "ast-grep", "ok"],
    ["options", "Options", "ok"],
    ["model-force", "Agent models", "ok"],
    ["effort", "Effort cap", "ok"],
    ["mods", "Mod policy", "ok"],
    ["hooks", "Hooks", "ok"],
    ["advisor", "Advisor", "ok"],
    ["statusline", "Status line", "ok"],
    ["setup-block", "CLAUDE.md", "ok"],
  ]);
});

test("mod version", () => {
  expect(run({}, "mod")).toEqual({ level: "ok", detail: "oh-my-claudeagent 3.0.0 is loaded" });
  expect(run({ modVersion: null }, "mod")).toEqual({ level: "warn", detail: "Could not read this mod's version from its manifest" });
});

test.each<[string, Omit<Check, "id" | "label">]>([
  ["2.1.287", { level: "ok", detail: "2.1.287 meets the 2.1.287 floor" }],
  ["2.2.0", { level: "ok", detail: "2.2.0 meets the 2.1.287 floor" }],
  ["2.1.290-dev", { level: "ok", detail: "2.1.290-dev meets the 2.1.287 floor" }],
  ["2.1.286", { level: "fail", detail: "2.1.286 is older than 2.1.287, which the OMCA mod needs" }],
  ["1.9.999", { level: "fail", detail: "1.9.999 is older than 2.1.287, which the OMCA mod needs" }],
  ["nightly", { level: "warn", detail: 'Could not read a version from "nightly"' }],
])("Claude Code %s", (engineVersion, expected) => {
  expect(run({ engineVersion }, "engine")).toEqual(expected);
});

test.each<[string | null, Omit<Check, "id" | "label">]>([
  [
    "1.4.2",
    {
      level: "ok",
      detail: "bun 1.4.2 is on PATH; Desktop and VS Code start .mcp.json with the GUI's PATH, which can lack ~/.bun/bin",
    },
  ],
  ["1.4.1", { level: "fail", detail: "bun 1.4.1 is older than 1.4.2, which the omca server needs" }],
  [null, { level: "fail", detail: "bun is not on this session's PATH, and the omca server runs on bun" }],
  ["", { level: "warn", detail: 'bun --version printed "", not a version' }],
])("bun %p", (bunVersion, expected) => {
  expect(run({ bunVersion }, "bun")).toEqual(expected);
});

test.each<[Inputs["hook"], Omit<Check, "id" | "label">]>([
  [{ kind: "seen", lastHookAt: NOW / 1000 - 30 }, { level: "ok", detail: "Last hook call under a minute ago" }],
  [{ kind: "seen", lastHookAt: NOW / 1000 - 600 }, { level: "ok", detail: "Last hook call 10 min ago" }],
  [
    { kind: "seen", lastHookAt: NOW / 1000 - 601 },
    { level: "warn", detail: "Last hook call 10 min ago; hooks may have stopped reaching it" },
  ],
  [{ kind: "seen", lastHookAt: NOW / 1000 + 5 }, { level: "ok", detail: "Last hook call under a minute ago" }],
  [{ kind: "missing" }, { level: "warn", detail: "No hook has reached the server in this session yet" }],
  [{ kind: "unsafe-id" }, { level: "warn", detail: "The session id cannot name a status file, so it was not read" }],
  [
    { kind: "unreadable", reason: "Unexpected end of JSON input" },
    { level: "warn", detail: "Could not read the session status file: Unexpected end of JSON input" },
  ],
])("server hook state %p", (hook, expected) => {
  expect(run({ hook }, "server")).toEqual(expected);
});

test("ast-grep or sg", () => {
  expect(run({}, "ast-grep")).toEqual({ level: "ok", detail: "ast-grep 0.39.0 is on PATH" });
  expect(run({ astGrep: { name: "sg", version: "0.38.1" } }, "ast-grep")).toEqual({ level: "ok", detail: "sg 0.38.1 is on PATH" });
  expect(run({ astGrep: null }, "ast-grep")).toEqual({
    level: "warn",
    detail: "Neither ast-grep nor sg is on PATH, so the five ast tools return an error",
  });
});

test.each<[unknown, Omit<Check, "id" | "label">]>([
  [undefined, { level: "info", detail: "No pluginConfigs entry, so the defaults apply: showBand on, guardMode dialog" }],
  [{ "other@omca": { options: {} } }, { level: "info", detail: "No pluginConfigs entry, so the defaults apply: showBand on, guardMode dialog" }],
  [{ "oh-my-claudeagent@inline": {} }, { level: "ok", detail: "showBand on, guardMode dialog, from oh-my-claudeagent@inline" }],
  [
    { "oh-my-claudeagent@omca": { options: { showBand: false, guardMode: "deny" } } },
    { level: "ok", detail: "showBand off, guardMode deny, from oh-my-claudeagent@omca" },
  ],
  [
    { "oh-my-claudeagent@omca": { options: { guardMode: "ask" } } },
    { level: "warn", detail: 'guardMode "ask" is not dialog or deny; dialog applies' },
  ],
  [
    { "oh-my-claudeagent@omca": { options: { showBand: "yes" } } },
    { level: "warn", detail: 'showBand "yes" is not true or false; on applies' },
  ],
])("pluginConfigs %p", (pluginConfigs, expected) => {
  expect(run({ settings: { pluginConfigs } }, "options")).toEqual(expected);
});

test.each<[string | undefined, Omit<Check, "id" | "label">]>([
  [undefined, { level: "ok", detail: "Each agent keeps the model tier it declares" }],
  ["0", { level: "ok", detail: "Each agent keeps the model tier it declares" }],
  ["1", { level: "warn", detail: "CLAUDE_CODE_SUBAGENT_MODEL_FORCE puts every agent on one model, oracle included" }],
])("CLAUDE_CODE_SUBAGENT_MODEL_FORCE=%p", (value, expected) => {
  expect(run({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: value } }, "model-force")).toEqual(expected);
});

test.each<[unknown, Omit<Check, "id" | "label">]>([
  [undefined, { level: "ok", detail: "No maxEffortLevel, so agents run at the effort they declare" }],
  ["max", { level: "ok", detail: "maxEffortLevel max leaves every declared effort in place" }],
  ["xhigh", { level: "ok", detail: "maxEffortLevel xhigh leaves every declared effort in place" }],
  ["high", { level: "warn", detail: "maxEffortLevel high holds oracle below the xhigh it declares" }],
  ["low", { level: "warn", detail: "maxEffortLevel low holds every agent below the effort it declares" }],
  ["turbo", { level: "warn", detail: 'maxEffortLevel "turbo" is not a known level' }],
])("maxEffortLevel %p", (maxEffortLevel, expected) => {
  expect(run({ settings: { maxEffortLevel } }, "effort")).toEqual(expected);
});

test.each<[Record<string, unknown>, Omit<Check, "id" | "label">]>([
  [{}, { level: "ok", detail: "Mods you install may load" }],
  [{ allowManagedModsOnly: true }, { level: "warn", detail: "allowManagedModsOnly loads OMCA's mod only if your organization installed it" }],
  [
    { pluginConfigs: { "cc-plugin-sec-default@builtin": { options: { allowManagedModsOnly: true } } } },
    { level: "warn", detail: "allowManagedModsOnly loads OMCA's mod only if your organization installed it" },
  ],
])("mod policy %p", (settings, expected) => {
  expect(run({ settings }, "mods")).toEqual(expected);
});

test.each<[Record<string, unknown>, Omit<Check, "id" | "label">]>([
  [{}, { level: "ok", detail: "Neither disableAllHooks nor allowManagedHooksOnly is set" }],
  [{ disableAllHooks: false }, { level: "ok", detail: "Neither disableAllHooks nor allowManagedHooksOnly is set" }],
  [{ disableAllHooks: true }, { level: "fail", detail: "disableAllHooks is on, so OMCA's gates and guidance never run" }],
  [{ allowManagedHooksOnly: true }, { level: "fail", detail: "allowManagedHooksOnly blocks OMCA's hooks unless your organization installed it" }],
])("hooks %p", (settings, expected) => {
  expect(run({ settings }, "hooks")).toEqual(expected);
});

test.each<[Record<string, unknown>, Inputs["env"], Omit<Check, "id" | "label">]>([
  [{ advisorModel: "fable" }, {}, { level: "ok", detail: "advisorModel fable, and nothing here keeps it off" }],
  [{}, {}, { level: "info", detail: "No advisorModel; /advisor fable turns the advisor on" }],
  [{}, { DO_NOT_TRACK: "0" }, { level: "info", detail: "No advisorModel; /advisor fable turns the advisor on" }],
  [
    { advisorModel: "fable" },
    { DISABLE_TELEMETRY: "0" },
    { level: "warn", detail: "DISABLE_TELEMETRY keeps the advisor off, so OMCA consults oracle instead" },
  ],
  [
    { advisorModel: "fable" },
    { DO_NOT_TRACK: "1" },
    { level: "warn", detail: "DO_NOT_TRACK keeps the advisor off, so OMCA consults oracle instead" },
  ],
  [
    {},
    { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" },
    { level: "warn", detail: "CLAUDE_CODE_DISABLE_ADVISOR_TOOL keeps the advisor off, so OMCA consults oracle instead" },
  ],
  [
    {},
    { DISABLE_GROWTHBOOK: "1" },
    { level: "warn", detail: "DISABLE_GROWTHBOOK keeps the advisor off, so OMCA consults oracle instead" },
  ],
  [
    {},
    { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    { level: "warn", detail: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC keeps the advisor off, so OMCA consults oracle instead" },
  ],
])("advisor %p %p", (settings, env, expected) => {
  expect(run({ settings, env }, "advisor")).toEqual(expected);
});

describe("status line", () => {
  const stale = "No refreshInterval, so it redraws on events only and goes stale while agents run";

  test("absent, set, or set to something that is not seconds", () => {
    expect(run({ settings: {} }, "statusline")).toEqual({ level: "info", detail: "No statusLine is set" });
    expect(run({}, "statusline")).toEqual({ level: "ok", detail: "Refreshes every 5 s as well as on events" });
    expect(run({ settings: { statusLine: { ...STATUS_LINE, refreshInterval: 0 } } }, "statusline")).toEqual({
      level: "warn",
      detail: "refreshInterval 0 is not a number of seconds of at least 1",
    });
  });

  test("missing refreshInterval offers the fix only when the user's file holds the statusLine in force", () => {
    const settings = { statusLine: STATUS_LINE };
    expect(run({ settings, userSettings: USER_SETTINGS }, "statusline")).toEqual({
      level: "warn",
      detail: stale,
      fix: "add-refresh-interval",
    });
    expect(run({ settings, userSettings: null }, "statusline")).toEqual({ level: "warn", detail: stale });
    expect(run({ settings, userSettings: "{}" }, "statusline")).toEqual({ level: "warn", detail: stale });
    expect(run({ settings: { statusLine: { ...STATUS_LINE, padding: 1 } }, userSettings: USER_SETTINGS }, "statusline")).toEqual({
      level: "warn",
      detail: stale,
    });
    expect(run({ settings, userSettings: "{ not json" }, "statusline")).toEqual({ level: "warn", detail: stale });
  });
});

describe("omca-setup block", () => {
  const BLOCK = "--- omca-setup\n\n# oh-my-claudeagent orchestration guidance\n\n--- /omca-setup ---\n";

  test.each<[string | null, Omit<Check, "id" | "label">]>([
    [null, { level: "ok", detail: "No omca-setup block in ~/.claude/CLAUDE.md" }],
    ["# Mine\n--- omca-setup is a phrase here\n", { level: "ok", detail: "No omca-setup block in ~/.claude/CLAUDE.md" }],
    [
      `# Mine\n\n${BLOCK}`,
      {
        level: "warn",
        detail: "~/.claude/CLAUDE.md holds the 2.x omca-setup block, which v3 replaces by delivering that guidance itself",
        fix: "remove-setup-block",
      },
    ],
    [
      "# Mine\n--- omca-setup\nunfinished\n",
      { level: "warn", detail: "~/.claude/CLAUDE.md opens an omca-setup block that never closes; remove it by hand" },
    ],
  ])("CLAUDE.md %p", (text, expected) => {
    expect(run({ claudeMd: { path: "~/.claude/CLAUDE.md", text } }, "setup-block")).toEqual(expected);
  });

  test("removal drops the marker lines and what lies between, and keeps every other byte", () => {
    expect(removeSetupBlock(`# Mine\n\n${BLOCK}\n# After\n`)).toBe("# Mine\n\n\n# After\n");
    expect(removeSetupBlock(`${BLOCK}tail`)).toBe("tail");
  });

  test("removal keeps CRLF line endings and trailing marker spaces count as the marker", () => {
    const crlf = "# Mine\r\n--- omca-setup  \r\nbody\r\n--- /omca-setup ---\r\n# After\r\n";
    expect(removeSetupBlock(crlf)).toBe("# Mine\r\n# After\r\n");
  });

  test("removal at the end of a file without a trailing newline", () => {
    expect(removeSetupBlock("# Mine\n--- omca-setup\nbody\n--- /omca-setup ---")).toBe("# Mine\n");
  });

  test("no block or an unclosed one is not rewritten", () => {
    expect(removeSetupBlock("# Mine\n")).toBeUndefined();
    expect(removeSetupBlock("--- omca-setup\nbody\n")).toBeUndefined();
    expect(setupBlock("--- omca-setup\nbody\n")).toBe("unclosed");
    expect(setupBlock("x\n--- omca-setup\n--- /omca-setup ---\ny")).toEqual({ from: 2, to: 37 });
  });
});

describe("refreshInterval rewrite", () => {
  test("adds the member after the last one at the object's indent, two spaces", () => {
    expect(addRefreshInterval(USER_SETTINGS)).toBe(
      `{\n  "statusLine": {\n    "type": "command",\n    "command": "omca-statusline",\n    "refreshInterval": 5\n  }\n}\n`,
    );
  });

  test("keeps tabs, CRLF, the rest of the file and a missing trailing newline", () => {
    const before = '{\r\n\t"model": "opus",\r\n\t"statusLine": {\r\n\t\t"type": "command",\r\n\t\t"command": "a \\"}\\" b"\r\n\t},\r\n\t"x": [1, {"statusLine": 2}]\r\n}';
    expect(addRefreshInterval(before)).toBe(
      '{\r\n\t"model": "opus",\r\n\t"statusLine": {\r\n\t\t"type": "command",\r\n\t\t"command": "a \\"}\\" b",\r\n\t\t"refreshInterval": 5\r\n\t},\r\n\t"x": [1, {"statusLine": 2}]\r\n}',
    );
  });

  test("a one-line object stays on one line", () => {
    expect(addRefreshInterval('{"statusLine": {"type": "command", "command": "s"}, "a": 1}\n')).toBe(
      '{"statusLine": {"type": "command", "command": "s", "refreshInterval": 5}, "a": 1}\n',
    );
  });

  test("a nested statusLine key is not the top-level one", () => {
    expect(addRefreshInterval('{"env": {"statusLine": {"a": 1}}, "statusLine": {"type": "command"}}')).toBe(
      '{"env": {"statusLine": {"a": 1}}, "statusLine": {"type": "command", "refreshInterval": 5}}',
    );
  });

  test("nothing to add, nowhere to add it, or a file that is not JSON", () => {
    expect(addRefreshInterval('{"statusLine": {"type": "command", "refreshInterval": 2}}')).toBeUndefined();
    expect(addRefreshInterval('{"model": "opus"}')).toBeUndefined();
    expect(addRefreshInterval('{"statusLine": "off"}')).toBeUndefined();
    expect(addRefreshInterval('{ "statusLine": { "type": "command" }, // comment\n}')).toBeUndefined();
  });
});

describe("unified diff", () => {
  test("one hunk around an insertion, with three lines of context either side", () => {
    const after = addRefreshInterval(USER_SETTINGS) ?? "";
    expect(unifiedDiff("a.bak", "a", USER_SETTINGS, after)).toBe(
      [
        "--- a.bak",
        "+++ a",
        "@@ -1,6 +1,7 @@",
        " {",
        '   "statusLine": {',
        '     "type": "command",',
        '-    "command": "omca-statusline"',
        '+    "command": "omca-statusline",',
        '+    "refreshInterval": 5',
        "   }",
        " }",
      ].join("\n"),
    );
  });

  test("a removal far from either end, from CRLF text", () => {
    const before = ["1", "2", "3", "4", "--- omca-setup", "x", "--- /omca-setup ---", "5", "6", "7", "8", ""].join("\r\n");
    expect(unifiedDiff("b", "a", before, removeSetupBlock(before) ?? "")).toBe(
      ["--- b", "+++ a", "@@ -2,9 +2,6 @@", " 2", " 3", " 4", "---- omca-setup", "-x", "---- /omca-setup ---", " 5", " 6", " 7"].join("\n"),
    );
  });

  test("removing a whole file's only lines", () => {
    expect(unifiedDiff("b", "a", "x\n", "")).toBe(["--- b", "+++ a", "@@ -1 +0,0 @@", "-x"].join("\n"));
  });
});
