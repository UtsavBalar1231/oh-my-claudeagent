#!/usr/bin/env bun
// Refreshes the committed engine types under .claude-plugin/types. Claude Code writes them when an
// interactive session loads the mod from a --plugin-dir folder; a -p session writes none. The
// session runs in tmux against the scripted mock model, so no request leaves the machine.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupOnSignal, REPO } from "./lib.ts";
import { startServer } from "./mock-model.ts";
import { exited, mockSessionEnv, quote, reachPrompt, sessionEnv, teardown, TERMINAL_OPTIONS, Tmux } from "./visual.ts";

const TYPES = join(REPO, ".claude-plugin", "types", "claude-code", "index.d.ts");
const writer = () => readFileSync(TYPES, "utf8").split("\n", 1)[0] ?? "";

const scratch = mkdtempSync(join(tmpdir(), "omca-types-"));
const cwd = join(scratch, "cwd");
const config = join(scratch, "config");
const mock = startServer({ port: 0 });
const tmux = new Tmux(`omca-types-${process.pid}`);
let claudePid: number | undefined;
const stop = () =>
  teardown(
    () => Bun.spawnSync(["tmux", "-L", tmux.socket, "kill-server"], { env: sessionEnv() }),
    () => claudePid !== undefined && exited(claudePid),
    () => mock.stop(true),
    () => rmSync(scratch, { recursive: true, force: true }),
  );
const release = cleanupOnSignal(stop);
try {
  mkdirSync(cwd);
  mkdirSync(config);
  writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  tmux.run([
    ...TERMINAL_OPTIONS,
    "new-session", "-d", "-s", tmux.target, "-x", "120", "-y", "40", "-c", cwd,
    "-e", `CLAUDE_CONFIG_DIR=${config}`,
    ...mockSessionEnv(mock.port),
    `claude --plugin-dir ${quote(REPO)}`,
  ]);
  claudePid = Number(tmux.run(["display-message", "-p", "-t", tmux.target, "#{pane_pid}"]).trim());
  await reachPrompt(tmux);
  console.log(writer());
} finally {
  release();
  await stop();
}
