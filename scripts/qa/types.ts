#!/usr/bin/env bun
// Refreshes the committed engine types under .claude-plugin/types. Claude Code writes them when an
// interactive session loads the mod from a --plugin-dir folder; a -p session writes none. The
// session runs in a pseudo-terminal against the scripted mock model, on a packaged copy whose
// types are deleted first, so the files appearing there is the sign the session wrote them.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { packageTree } from "../package.ts";
import { cleanupOnSignal, REPO } from "./lib.ts";
import { startServer } from "./mock-model.ts";
import { mockEnv, sessionEnv, teardown } from "./visual.ts";

if (process.platform === "win32") {
  console.error("just types drives an interactive Claude Code session through a POSIX pseudo-terminal, so it runs on Linux or macOS.");
  process.exit(1);
}

const TYPES = join(".claude-plugin", "types");
const CORE = join("claude-code", "index.d.ts");
const WRITTEN = [CORE, join("claude-code-tools", "index.d.ts"), "tsconfig.json"];
// Its content depends on which MCP servers connected in time, and nothing in the mod reads it.
const MCP_TYPES = join("claude-code-mcp", "index.d.ts");
const POLL_MS = 250;
const WRITE_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 10_000;
const TAIL_CHARS = 2_000;

const scratch = mkdtempSync(join(tmpdir(), "omca-types-"));
const plugin = join(scratch, "plugin");
const cwd = join(scratch, "cwd");
const config = join(scratch, "config");
const written = join(plugin, TYPES);
const mock = startServer({ port: 0 });
const decoder = new TextDecoder();
let output = "";
let session: Bun.Subprocess | undefined;
let exitCode: number | undefined;

const tail = (): string => Bun.stripANSI(output).slice(-TAIL_CHARS);

function sizes(): string | undefined {
  const found = WRITTEN.map((file) => statSync(join(written, file), { throwIfNoEntry: false })?.size);
  return found.every((size) => size !== undefined) ? found.join() : undefined;
}

/** Resolves once every written file exists and kept its size across two polls, or to the session's exit code when it ended first. */
async function typesWritten(): Promise<number | undefined> {
  const deadline = Date.now() + WRITE_TIMEOUT_MS;
  let last: string | undefined;
  while (Date.now() < deadline) {
    if (exitCode !== undefined) return exitCode;
    const now = sizes();
    if (now !== undefined && now === last) return undefined;
    last = now;
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`claude wrote no complete engine types within ${WRITE_TIMEOUT_MS} ms; the end of its output:\n${tail()}`);
}

// The scratch folder's own name, which reads the same whether a command line spells the path
// resolved or not (/private/var or /var on macOS).
/** Processes this run started that outlived the session: their command line names the scratch folder. */
function survivors(): number[] {
  const mark = basename(scratch);
  return Bun.spawnSync(["ps", "axww", "-o", "pid=,args="], { stderr: "ignore" })
    .stdout.toString()
    .split("\n")
    .filter((line) => line.includes(mark))
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => pid !== process.pid);
}

async function gone(pids: readonly number[]): Promise<boolean> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pids.some(alive)) return true;
    await Bun.sleep(POLL_MS);
  }
  return false;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids.filter(alive)) process.kill(pid, name);
}

// The copy ships .mcp.json, so the session starts the omca server, which can outlive the PTY child.
async function endSession(proc: Bun.Subprocess): Promise<void> {
  proc.kill("SIGTERM");
  if (!(await gone([proc.pid]))) proc.kill("SIGKILL");
  await proc.exited;
  const left = survivors();
  if (left.length === 0) return;
  signal(left, "SIGTERM");
  if (await gone(left)) return;
  signal(left, "SIGKILL");
  if (!(await gone(left))) throw new Error(`processes ${left.join(", ")} under ${scratch} outlived SIGKILL`);
}

function place(file: string): void {
  const to = join(REPO, TYPES, file);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(written, file), to);
}

const stop = () =>
  teardown(
    () => session !== undefined && endSession(session),
    () => mock.stop(true),
    () => rmSync(scratch, { recursive: true, force: true }),
  );
const release = cleanupOnSignal(stop);
let failedWith: number | undefined;
try {
  packageTree(REPO, plugin);
  rmSync(written, { recursive: true, force: true });
  mkdirSync(cwd);
  mkdirSync(config);
  writeFileSync(
    join(config, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true } } }),
  );
  const proc = Bun.spawn(["claude", "--plugin-dir", plugin], {
    cwd,
    env: { ...sessionEnv(), ...mockEnv(mock.port), CLAUDE_CONFIG_DIR: config, TERM: "xterm-256color" },
    terminal: {
      cols: 120,
      rows: 40,
      data: (_terminal, data) => {
        output += decoder.decode(data, { stream: true });
      },
    },
  });
  session = proc;
  void proc.exited.then((code) => {
    exitCode = code;
  });
  failedWith = await typesWritten();
  if (failedWith === undefined) {
    for (const file of WRITTEN) place(file);
    if (!existsSync(join(REPO, TYPES, MCP_TYPES)) && existsSync(join(written, MCP_TYPES))) place(MCP_TYPES);
  } else {
    console.error(`claude exited ${failedWith} before it wrote the engine types; the end of its output:\n${tail()}`);
  }
} finally {
  release();
  await stop();
}
if (failedWith === undefined) console.log(readFileSync(join(REPO, TYPES, CORE), "utf8").split("\n", 1)[0] ?? "");
else process.exitCode = failedWith === 0 ? 1 : failedWith;
