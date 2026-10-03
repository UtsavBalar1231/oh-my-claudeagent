import type { McpConnectResult, On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { ROOT, SESSION, type World, world, write } from "./world.ts";

const MARKER = `${ROOT}/.omca/state/mod/${SESSION}.json`;
const OFF = "its tools, guidance and stop gates are off for this session";
const NO_BUN =
  `bun is not on PATH, so the omca server did not start and ${OFF}. Install bun 1.4.2 or later and restart Claude Code. ` +
  "In Claude Desktop or VS Code, put bun's folder (usually ~/.bun/bin) on the PATH the app starts with.";

type Seen = { connects: string[]; runs: string[][]; world: World };

function engine(on: On, connect: McpConnectResult | { deny: string }, bun: "ok" | "missing" | "failing"): Seen {
  const w = world(on);
  const seen: Seen = { connects: [], runs: [], world: w };
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("session.usage", () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("fs.write", (_$, e) => (write(w, e.path, e.text), { value: undefined }));
  on("mcp.connect", (_$, e) => {
    seen.connects.push(e.server);
    return "deny" in connect ? { deny: connect.deny } : { value: connect };
  });
  on("process.run", (_$, e) => {
    seen.runs.push([...e.argv]);
    if (bun === "missing") return { deny: "spawn bun ENOENT" };
    const exitCode = bun === "failing" ? 127 : 0;
    return { value: { exitCode, stdout: "1.4.2\n", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
  });
  return seen;
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
const refused = (message: string): McpConnectResult => ({ isConnected: false, reason: "failed", message });

test("a connected omca server says nothing and never looks for bun", async ($, on) => {
  const seen = engine(on, { isConnected: true, server: "plugin:oh-my-claudeagent:omca" }, "ok");
  await start($);
  expect(seen.connects).toEqual(["omca"]);
  expect(seen.runs).toEqual([]);
  expect(seen.world.said).toEqual([]);
});

test("a refused server with no bun on PATH says what is missing and how to fix it", async ($, on) => {
  const seen = engine(on, refused("spawn bun ENOENT"), "missing");
  await start($);
  expect(seen.runs).toEqual([["bun", "--version"]]);
  expect(seen.world.said).toEqual([NO_BUN]);
});

test("a refused server with a bun that exits non-zero says bun is missing", async ($, on) => {
  const seen = engine(on, refused("exit 127"), "failing");
  await start($);
  expect(seen.world.said).toEqual([NO_BUN]);
});

test("a refused server with bun present quotes the engine's reason and points at /mcp", async ($, on) => {
  const seen = engine(on, { isConnected: false, reason: "disabled", message: "the server is turned off" }, "ok");
  await start($);
  expect(seen.world.said).toEqual([`the omca server is not connected (the server is turned off), so ${OFF}. Run /mcp to see why.`]);
});

test("a connect the engine refuses is logged to debug, says nothing on screen and leaves the marker written", async ($, on) => {
  const seen = engine(on, { deny: "connect unavailable" }, "ok");
  await start($);
  expect(seen.world.said).toEqual([]);
  expect(seen.world.logs).toContain("serverCheck post session.start failed: connect unavailable");
  expect(seen.world.files.has(MARKER)).toBe(true);
});

test("the server is looked up once, at session start, and not at each turn", async ($, on) => {
  const seen = engine(on, refused("spawn bun ENOENT"), "missing");
  await start($);
  await $.turn.start({ text: "go", turnId: "t-1" });
  await $.turn.start({ text: "again", turnId: "t-2" });
  expect(seen.connects).toEqual(["omca"]);
  expect(seen.world.said).toEqual([NO_BUN]);
});
