import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createContext } from "./core.ts";
import { cleanup, fixture, runNamed } from "./fixture.ts";
import {
  checks,
  compactMessages,
  duplicateRegistration,
  guardedEvents,
  hookSources,
  onLocation,
  REGISTER,
  registrations,
  type Source,
  toolCheckAllow,
} from "./mod.ts";

afterEach(cleanup);

const register = (...lines: string[]): Source[] => [{ path: REGISTER, text: lines.join("\n") }];
const other = (path: string, text: string): Source => ({ path, text });

describe("registrations", () => {
  test("reads the event and a normalized matcher, and ignores a method named on", () => {
    const text = [
      "on('command.run', {command:'omca'}, hook);",
      'on("tool.check", { tool: /^(?:Bash|PowerShell)$/ }, hook);',
      'on("session.start", hook);',
      'emitter.on("x", f);',
      'addon("y");',
    ].join("\n");
    expect(registrations(register(text)).map((r) => [r.event, r.matcher, r.call])).toEqual([
      ["command.run", '{command:"omca"}', 'on("command.run", {command:"omca"})'],
      ["tool.check", "{tool:/^(?:Bash|PowerShell)$/}", 'on("tool.check", {tool:/^(?:Bash|PowerShell)$/})'],
      ["session.start", "", 'on("session.start")'],
    ]);
  });
});

describe("mod guarded events", () => {
  const patterns = [
    "classic.PreToolUse",
    "classic.*",
    "prompt.context",
    "prompt.section",
    "prompt.compose",
    "skill.prompt",
    "attribution.text",
    "settings.read",
    "prompt.*",
    "*",
    "!tool.describe",
  ];

  test("every event the guard continues, and every glob or negation that reaches one, fails", () => {
    const sources = register(...patterns.map((pattern) => `on("${pattern}", hook);`));
    expect(guardedEvents(sources)).toEqual({
      status: "fail",
      detail: patterns.map((pattern) => `${REGISTER}: on("${pattern}") reaches an event the sec-default guard continues`).join("; "),
    });
  });

  test("guard-safe events and a settings read through the host pass", () => {
    const sources = register('on("tool.check", { tool: "Bash" }, hook);', 'on("ui.*", hook);', 'on("prompt.edit", hook);', "await host.settings.read();");
    expect(guardedEvents(sources)).toMatchObject({ status: "pass" });
  });
});

describe("mod on() location", () => {
  test("a registration outside register.ts fails, a method named on does not", () => {
    const sources = [other("hooks/band.ts", 'on("turn.complete", hook);\nemitter.on("x", f);\naddon("y");'), ...register('on("turn.start", hook);')];
    expect(onLocation(sources)).toEqual({ status: "fail", detail: `hooks/band.ts: on("turn.complete") outside ${REGISTER}` });
  });

  test("registrations in register.ts alone pass", () => {
    expect(onLocation(register('on("turn.start", hook);'))).toMatchObject({ status: "pass" });
  });
});

describe("mod tool.check allow", () => {
  test("a file that handles tool.check and names an allow decision fails", () => {
    const sources = [other("hooks/bash-guard.ts", 'const e = "tool.check";\nreturn { decision: "allow" };')];
    expect(toolCheckAllow(sources)).toEqual({
      status: "fail",
      detail: "hooks/bash-guard.ts: names tool.check and an allow decision, and an allow there skips the auto-mode classifier",
    });
  });

  test("single-quoted and template-quoted allow fail too", () => {
    for (const quote of ["'", "`"]) {
      expect(toolCheckAllow([other("hooks/a.ts", `"tool.check"; x = ${quote}allow${quote};`)]).status).toBe("fail");
    }
  });

  test("a deny, or an allow in a file that never names tool.check, passes", () => {
    const sources = [other("hooks/bash-guard.ts", '"tool.check"; return { decision: "deny" };'), other("hooks/pane.ts", 'const mode = "allow";')];
    expect(toolCheckAllow(sources)).toMatchObject({ status: "pass" });
  });
});

describe("mod session.compact messages", () => {
  test("a file that handles session.compact and answers with messages fails, keyed or shorthand", () => {
    for (const answer of ["{ messages: [] }", "{ instructions, messages }", "{ messages }"]) {
      expect(compactMessages([other("hooks/compact.ts", `"session.compact"; return ${answer};`)])).toEqual({
        status: "fail",
        detail: "hooks/compact.ts: session.compact answers with messages, which are lost on resume",
      });
    }
  });

  test("an instructions rewrite passes, and messages in a file that never names session.compact is not flagged", () => {
    const sources = [other("hooks/compact.ts", '"session.compact"; return { instructions: "x" };'), other("hooks/pane.ts", "const messages = [];")];
    expect(compactMessages(sources)).toMatchObject({ status: "pass" });
  });
});

describe("mod duplicate registration", () => {
  test("a second registration of one event and matcher fails, a different matcher does not", () => {
    const sources = register(
      'on("command.run", { command: "omca" }, hook);',
      "on('command.run', {command:'omca'}, hook);",
      'on("command.run", { command: "other" }, hook);',
      'on("session.start", hook);',
    );
    expect(duplicateRegistration(sources)).toEqual({
      status: "fail",
      detail: `${REGISTER}: on("command.run", {command:"omca"}) registered twice`,
    });
  });

  test("the same event twice with no matcher fails", () => {
    expect(duplicateRegistration(register('on("turn.start", a);', 'on("turn.start", b);')).status).toBe("fail");
  });
});

describe("mod register.ts", () => {
  test("a missing register.ts fails, and so does one with no registration", async () => {
    expect(await runNamed(checks, "mod register.ts", fixture({ "hooks/register.ts": null }))).toEqual({
      status: "fail",
      detail: `${REGISTER} is missing`,
    });
    expect(await runNamed(checks, "mod register.ts", fixture({ "hooks/register.ts": "export {};\n" }))).toEqual({
      status: "fail",
      detail: `${REGISTER} registers no on() handler`,
    });
  });

  test("a register.ts with registrations passes", async () => {
    expect(await runNamed(checks, "mod register.ts", fixture())).toEqual({ status: "pass", detail: `${REGISTER} makes 2 registrations` });
  });
});

describe("the real tree", () => {
  test("every mod check passes on hooks/", async () => {
    const ctx = createContext(join(import.meta.dir, "..", ".."));
    for (const check of checks) expect(await check.run(ctx)).toMatchObject({ status: "pass" });
  });

  test("the real register.ts is read: its three ui.render matchers count as three registrations", () => {
    const ctx = createContext(join(import.meta.dir, "..", ".."));
    const calls = registrations(hookSources(ctx)).map((r) => r.call);
    expect(calls).toContain('on("command.run", {command:"omca"})');
    expect(calls.filter((call) => call.startsWith('on("ui.render"'))).toEqual([
      'on("ui.render", {component:"AbovePrompt"})',
      'on("ui.render", {component:"Pane"})',
      'on("ui.render", {component:"Spinner"})',
    ]);
  });
});
