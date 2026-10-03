#!/usr/bin/env bun
// Drives one interactive Claude Code session in tmux against the scripted mock model and the
// packaged plugin's real MCP server, once with MCP_PROTOCOL_NEGOTIATION=auto (the client sends
// server/discover first) and once without (it sends initialize). ast-grep is a fake that sleeps,
// so a call stays in flight long enough to watch and to cancel. Per mode it checks that
//   - the client's debug log names the expected handshake,
//   - a progress line shows on the tool call while it runs and then updates,
//   - Escape cancels the call and the fake ast-grep process is gone,
//   - /mcp lists every tool title with the badge its annotations call for.
//
// Usage: bun scripts/qa/mcp-live.ts
//        MCP_LIVE_SCREENS=1 prints each captured screen.
// Exit: 0 every check passed, 1 a check failed, 2 the run could not be set up.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExec } from "../../tests/fixtures/fake-exec.ts";
import { specEnv } from "../../tests/fixtures/spec-env.ts";
import { type Checks, cleanupOnSignal, runQa, type Scratch } from "./lib.ts";
import { type Script, startServer } from "./mock-model.ts";
import { exited, mockSessionEnv, quote, reachPrompt, sessionEnv, teardown, Tmux } from "./visual.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000002";
const SEARCH = "mcp__plugin_oh-my-claudeagent_omca__ast_search";
const PROMPT_TEXT = "Search the code for x";
const FAKE_SLEEP_MS = 90_000;
const WAIT_MS = 30_000;
const POLL_MS = 150;
const SHOW_SCREENS = process.env.MCP_LIVE_SCREENS === "1";

type Mode = { name: string; negotiation: "auto" | undefined; handshake: string };
const MODES: readonly Mode[] = [
  { name: "initialize (default)", negotiation: undefined, handshake: '"protocolEra":"legacy","negotiatedProtocolVersion":"2025-11-25"' },
  { name: "server/discover (MCP_PROTOCOL_NEGOTIATION=auto)", negotiation: "auto", handshake: '"protocolEra":"modern","negotiatedProtocolVersion":"2026-07-28"' },
];

type Annotations = { title: string; readOnlyHint: boolean; destructiveHint?: boolean };

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(isDone: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!isDone()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(POLL_MS);
  }
}

const show = (label: string, screen: string): void => {
  if (SHOW_SCREENS) console.log(`--- ${label} ---\n${screen}\n--- end ${label} ---`);
};

const badgeOf = ({ readOnlyHint, destructiveHint }: Annotations): string => (readOnlyHint ? "read-only" : destructiveHint === true ? "destructive" : "");
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function declaredAnnotations(plugin: string, cwd: string): Promise<Annotations[]> {
  const requests = ["initialize", "tools/list"].map((method, i) => ({ jsonrpc: "2.0", id: i + 1, method, params: { protocolVersion: "2025-11-25" } }));
  const proc = Bun.spawn([process.execPath, join(plugin, "servers", "omca.ts")], {
    cwd,
    env: specEnv(),
    stdin: Buffer.from(requests.map((request) => `${JSON.stringify(request)}\n`).join("")),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const replies = out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: number; result?: { tools: Array<{ annotations: Annotations }> } });
  const tools = replies.find((reply) => reply.id === 2)?.result?.tools;
  if (tools === undefined) throw new Error("the packaged server did not answer tools/list");
  return tools.map((tool) => tool.annotations);
}

async function runMode(mode: Mode, checks: Checks, scratch: Scratch): Promise<void> {
  const tag = mode.name;
  const project = scratch.project();
  const dir = scratch.dir("live");
  const config = join(dir, "config");
  const pidFile = join(dir, "ast-grep.pid");
  const debugFile = join(dir, "claude-debug.log");
  mkdirSync(config);
  const plugin = scratch.plugin();
  const declared = await declaredAnnotations(plugin, project);
  const fake = fakeExec(
    dir,
    "ast-grep",
    [`import { writeFileSync } from "node:fs";`, `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`, `await Bun.sleep(${FAKE_SLEEP_MS});`].join("\n"),
  );
  writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  writeFileSync(join(config, "settings.json"), JSON.stringify({ tui: "fullscreen", permissions: { allow: [SEARCH] } }));
  const script: Script = {
    main: [{ content: [{ type: "tool_use", name: SEARCH, input: { pattern: "x", lang: "python" } }] }],
    subagent: [],
  };
  const mock = startServer({ port: 0, script });
  const tmux = new Tmux(`omca-mcp-live-${process.pid}`, ["-f", "/dev/null"]);
  let claudePid: number | undefined;
  let fakePid: number | undefined;
  const stopProcesses = () =>
    teardown(
      () => Bun.spawnSync(["tmux", "-L", tmux.socket, "-f", "/dev/null", "kill-server"], { env: sessionEnv() }),
      () => claudePid !== undefined && exited(claudePid),
      () => fakePid !== undefined && isAlive(fakePid) && process.kill(fakePid),
      () => mock.stop(true),
    );
  const release = cleanupOnSignal(stopProcesses);
  try {
    tmux.run([
      "new-session", "-d", "-s", tmux.target, "-x", "140", "-y", "50", "-c", project,
      "-e", `CLAUDE_CONFIG_DIR=${config}`,
      "-e", `AST_GREP_BIN=${fake}`,
      ...(mode.negotiation === undefined ? [] : ["-e", `MCP_PROTOCOL_NEGOTIATION=${mode.negotiation}`]),
      ...mockSessionEnv(mock.port),
      `claude --plugin-dir ${quote(plugin)} --session-id ${SESSION_ID} --debug mcp --debug-file ${quote(debugFile)}`,
    ]);
    claudePid = Number(tmux.run(["display-message", "-p", "-t", tmux.target, "#{pane_pid}"]).trim());
    await reachPrompt(tmux);

    const connected = readFileSync(debugFile, "utf8")
      .split("\n")
      .find((line) => line.includes("plugin:oh-my-claudeagent:omca") && line.includes("Connection established"));
    checks.check(connected?.includes(mode.handshake) === true, `${tag}: the client's debug log shows ${mode.handshake}`, `${tag}: the debug log lacks ${mode.handshake}; it has: ${connected}`);

    tmux.send("-l", PROMPT_TEXT);
    await tmux.waitFor((screen) => screen.includes(PROMPT_TEXT), WAIT_MS, "the prompt to be typed");
    tmux.send("Enter");

    const first = await tmux.waitFor((screen) => /⎿\s+ast-grep running\s*$/m.test(screen), WAIT_MS, "a progress line on the tool call");
    show(`${tag}: progress line`, first);
    checks.pass(`${tag}: a progress line shows on the tool call while ast-grep runs`);
    const later = await tmux.waitFor((screen) => /⎿\s+ast-grep running, [1-9]\d*s/.test(screen), WAIT_MS, "the progress line to update");
    show(`${tag}: progress line updated`, later);
    checks.pass(`${tag}: the progress line updates with the elapsed time`);

    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", "the fake ast-grep to start");
    fakePid = Number(readFileSync(pidFile, "utf8"));
    checks.check(isAlive(fakePid), `${tag}: the fake ast-grep (pid ${fakePid}) is running before Escape`, `${tag}: the fake ast-grep is not running before Escape`);

    tmux.send("Escape");
    await until(() => !isAlive(fakePid ?? 0), "the fake ast-grep to be gone after Escape");
    checks.pass(`${tag}: Escape cancelled the call and the fake ast-grep process is gone`);
    const cancelled = await tmux.settle(later);
    show(`${tag}: after Escape`, cancelled);
    checks.check(cancelled.includes("Interrupted"), `${tag}: the tool line reads Interrupted`, `${tag}: the tool line does not read Interrupted`);

    tmux.send("-l", "/mcp");
    await tmux.waitFor((screen) => screen.includes("/mcp"), WAIT_MS, "/mcp to be typed");
    tmux.send("Enter");
    let screen = await tmux.settle(cancelled);
    for (const key of ["Down", "Down", "Enter", "Enter"]) {
      tmux.send(key);
      screen = await tmux.settle(screen);
    }
    show(`${tag}: /mcp tools`, screen);
    const wrong = declared.filter((annotations) => {
      const row = new RegExp(`^\\s*(?:❯\\s+)?${escapeRegExp(annotations.title)}(?:\\s+(read-only|destructive))?\\s*$`, "m").exec(screen);
      return row === null || (row[1] ?? "") !== badgeOf(annotations);
    });
    checks.check(
      wrong.length === 0 && declared.length > 0,
      `${tag}: /mcp lists all ${declared.length} tool titles, ${declared.filter((tool) => tool.readOnlyHint).length} with the read-only badge`,
      `${tag}: /mcp rows are wrong for ${wrong.map((tool) => tool.title).join(", ")}`,
    );
  } finally {
    release();
    await teardown(
      stopProcesses,
      () => {
        const noTmux = Bun.spawnSync(["tmux", "-L", tmux.socket, "-f", "/dev/null", "list-sessions"], { env: sessionEnv(), stdout: "pipe", stderr: "pipe" }).exitCode !== 0;
        checks.check(
          noTmux && (claudePid === undefined || !isAlive(claudePid)) && (fakePid === undefined || !isAlive(fakePid)),
          `${tag}: teardown left no tmux server, claude process or fake ast-grep`,
          `${tag}: teardown left a process behind`,
        );
      },
    );
  }
}

if (import.meta.main) {
  await runQa(
    "mcp-live",
    async ({ checks, scratch }) => {
      for (const mode of MODES) await runMode(mode, checks, scratch);
    },
    { watchRealConfig: true },
  );
}
