import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanup, fixture, json, runNamed } from "./fixture.ts";
import { checks } from "./hooks.ts";

afterEach(cleanup);

const REPO = join(import.meta.dir, "..", "..");

const entry = (overrides: Record<string, unknown> = {}) => ({
  type: "mcp_tool",
  server: "plugin:oh-my-claudeagent:omca",
  tool: "omca_hook",
  timeout: 10,
  ...overrides,
});

const hooksWith = (handler: Record<string, unknown>) =>
  json({ modules: ["./register.ts"], hooks: { Stop: [{ hooks: [handler] }] } });

describe("hook handlers", () => {
  test("a consistent tree passes", async () => {
    for (const check of checks) expect(await check.run(fixture())).toMatchObject({ status: "pass" });
  });

  test("a command handler fails, whatever its shell field says", async () => {
    const ctx = fixture({ "hooks/hooks.json": hooksWith({ type: "command", command: "x.sh", shell: "bash", timeout: 10 }) });
    expect(await runNamed(checks, "hook handlers", ctx)).toEqual({
      status: "fail",
      detail: [
        'Stop handler has type "command", expected "mcp_tool"',
        'Stop handler names server undefined, expected "plugin:oh-my-claudeagent:omca"',
        'Stop handler names tool undefined, expected "omca_hook"',
      ].join("; "),
    });
  });

  test("a bare server name fails, since the client then never resolves the tool", async () => {
    const ctx = fixture({ "hooks/hooks.json": hooksWith(entry({ server: "omca" })) });
    expect(await runNamed(checks, "hook handlers", ctx)).toEqual({
      status: "fail",
      detail: 'Stop handler names server "omca", expected "plugin:oh-my-claudeagent:omca"',
    });
  });

  test("another tool fails", async () => {
    const ctx = fixture({ "hooks/hooks.json": hooksWith(entry({ tool: "health_check" })) });
    expect(await runNamed(checks, "hook handlers", ctx)).toEqual({
      status: "fail",
      detail: 'Stop handler names tool "health_check", expected "omca_hook"',
    });
  });

  test.each([[{ timeout: undefined }], [{ timeout: 0 }], [{ timeout: "10" }]])("a timeout of %p fails", async (override) => {
    const ctx = fixture({ "hooks/hooks.json": hooksWith(entry(override)) });
    expect(await runNamed(checks, "hook handlers", ctx)).toEqual({ status: "fail", detail: "Stop handler sets no positive timeout" });
  });

  test("a registry with no object or no handler fails", async () => {
    const noObject = fixture({ "hooks/hooks.json": json({ hooks: [] }) });
    expect(await runNamed(checks, "hook handlers", noObject)).toEqual({ status: "fail", detail: "hooks.json has no hooks object" });
    const empty = fixture({ "hooks/hooks.json": json({ hooks: { Stop: [] } }) });
    expect(await runNamed(checks, "hook handlers", empty)).toEqual({ status: "fail", detail: "hooks.json registers no handler" });
  });

  test("a server key that .mcp.json does not register fails", async () => {
    const ctx = fixture({ ".mcp.json": json({ mcpServers: { other: {} } }) });
    expect(await runNamed(checks, "hook handlers", ctx)).toEqual({
      status: "fail",
      detail: '.mcp.json registers no "omca" server for plugin:oh-my-claudeagent:omca',
    });
  });
});

describe("hook modules", () => {
  test.each([[undefined], [[]], [["./register.ts", "./extra.ts"]], [["register.ts"]]])("modules %p fails", async (modules) => {
    const ctx = fixture({ "hooks/hooks.json": json({ modules, hooks: { Stop: [{ hooks: [entry()] }] } }) });
    const result = await runNamed(checks, "hook modules", ctx);
    expect(result.status).toBe("fail");
    expect(result.detail).toBe(`modules is ${JSON.stringify(modules)}, expected ["./register.ts"]`);
  });
});

describe("SessionStart matcher", () => {
  const sessionStart = (group: Record<string, unknown>) =>
    json({ modules: ["./register.ts"], hooks: { SessionStart: [{ ...group, hooks: [entry()] }] } });

  test("an entry with no matcher fails, since mcp_tool hooks are skipped for SessionStart at launch", async () => {
    const ctx = fixture({ "hooks/hooks.json": sessionStart({}) });
    expect(await runNamed(checks, "SessionStart matcher", ctx)).toEqual({
      status: "fail",
      detail: 'SessionStart entry 1 has matcher undefined, expected "clear|compact"',
    });
  });

  test.each(["clear", "compact|clear", "startup|resume"])("the matcher %p fails", async (matcher) => {
    const ctx = fixture({ "hooks/hooks.json": sessionStart({ matcher }) });
    expect(await runNamed(checks, "SessionStart matcher", ctx)).toEqual({
      status: "fail",
      detail: `SessionStart entry 1 has matcher "${matcher}", expected "clear|compact"`,
    });
  });

  test("other events need no matcher", async () => {
    const hooks = json({
      modules: ["./register.ts"],
      hooks: { SessionStart: [{ matcher: "clear|compact", hooks: [entry()] }], Stop: [{ hooks: [entry()] }] },
    });
    expect(await runNamed(checks, "SessionStart matcher", fixture({ "hooks/hooks.json": hooks }))).toMatchObject({ status: "pass" });
  });

  test("a registry with no SessionStart entry fails", async () => {
    expect(await runNamed(checks, "SessionStart matcher", fixture({ "hooks/hooks.json": hooksWith(entry()) }))).toEqual({
      status: "fail",
      detail: "hooks.json has no SessionStart entry",
    });
  });
});

describe("hook registry reach", () => {
  test("a handler file the registry never imports fails", async () => {
    const ctx = fixture({ "servers/hooks/orphan.ts": "export const handle = 2;\n" });
    expect(await runNamed(checks, "hook registry reach", ctx)).toEqual({
      status: "fail",
      detail: "servers/hooks/orphan.ts is not reached from registry.ts, so it is dead code",
    });
  });

  test("a file reached through another handler's import counts as reached", async () => {
    const ctx = fixture({
      "servers/hooks/one.ts": 'import { helper } from "./helper.ts";\nexport const handle = helper;\n',
      "servers/hooks/helper.ts": 'export const helper = 1;\nexport { x } from "./deeper.ts";\n',
      "servers/hooks/deeper.ts": "export const x = 1;\n",
    });
    expect(await runNamed(checks, "hook registry reach", ctx)).toMatchObject({ status: "pass" });
  });

  test("a spec file needs no import, and a missing registry fails", async () => {
    expect(await runNamed(checks, "hook registry reach", fixture({ "servers/hooks/orphan.spec.ts": "export {};\n" }))).toMatchObject({ status: "pass" });
    expect(await runNamed(checks, "hook registry reach", fixture({ "servers/hooks/registry.ts": null }))).toEqual({
      status: "fail",
      detail: "servers/hooks/registry.ts is missing",
    });
  });

  test("every non-spec file under servers/hooks in the real tree is reached", async () => {
    const result = await runNamed(checks, "hook registry reach", fixture({}, { root: REPO }));
    expect(result.status).toBe("pass");
  });
});
