#!/usr/bin/env bun
// Opens one view of the mod in a real Claude Code session inside tmux, against the scripted
// mock model, and saves the screen at each harness size.
//
// Usage: bun scripts/qa/visual.ts <view> [--root <dir>] [--sizes 80x24,160x30] [--out <dir>]
//
// <root>/<view>.json, root defaulting to tests/mod/visual:
//   command     text typed at the prompt, then Enter: a slash command or a prompt
//   keys        tmux send-keys arguments sent one at a time afterwards, each a key name
//               (Enter, Down, Escape, C-x) or text; none when absent. A mouse step,
//               `wheel-down*3@<text>`, `wheel-up@<text>` or `click@<text>`, with an optional
//               `:+dx,+dy`, lands on the first cell where <text> shows, moved by the offset
//   mockScript  <root>/scripts/<name>.json, the {main, subagent} turns mock-model.ts serves;
//               absent or null, every request is answered "ok"
//   fixture     <root>/fixtures/<name>/, copied as the session's cwd, with "{{cwd}}" in its
//               files replaced by that cwd; absent or null, an empty directory. A plan its
//               boulder.json names but does not hold is taken from tests/fixtures/plans/.
// Writes <root>/<view>-<cols>.txt for 80x40 (an inline pane), 120x40 and 200x50 (docked), with
// the scratch directory's random suffix and the live session's own times and costs masked. `--sizes`
// captures those sizes instead, as <out>/<view>-<cols>x<rows>.txt, out defaulting to root.
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { displayWidth } from "../../src/core/ui-kit.ts";
import { envWithout } from "../validate/core.ts";
import { cleanupOnSignal, REPO } from "./lib.ts";
import { parseScript, type Script, startServer } from "./mock-model.ts";

const SHARED_PLANS = join(REPO, "tests", "fixtures", "plans");
// A file's age reads the same in every capture at an hour, and the files still postdate every
// evidence entry a fixture holds, so a task's proof does not change.
const FIXTURE_AGE_MS = 3_600_000;
const MKDTEMP_SUFFIX = 6;
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SIZES = [
  [80, 40],
  [120, 40],
  [200, 50],
] as const;
const POLL_MS = 150;
const STABLE_POLLS = 4;
const START_TIMEOUT_MS = 30_000;
const CHANGE_TIMEOUT_MS = 3_000;
const SETTLE_TIMEOUT_MS = 30_000;
// The trust dialog is drawn before it takes keys, so a Down sent at once can be lost.
const RESEND_MS = 1_000;
const EXIT_TIMEOUT_MS = 10_000;
// The input box: its top rule, then the prompt line. The trust dialog's pointer follows no rule,
// and the engine draws a no-break space after each pointer.
const PROMPT = /^─{3,}.*\n❯/m;
const TRUST = "Yes, I trust this folder";
const TRUST_SELECTED = /❯\s*Yes, I trust this folder/;
const TRUST_UNSELECTED = /❯\s*No, exit/;

export type View = { command: string; keys: string[]; mockScript: string | null; fixture: string | null };

const MOUSE = /^(wheel-up|wheel-down|click)(?:\*(\d+))?@(.+?)(?::([+-]\d+),([+-]\d+))?$/;

/**
 * The SGR mouse reports for a mouse step, or undefined for a key: a wheel tick per count, or a
 * press and release, at the first cell where the anchor shows on `screen`, moved by the offset.
 */
export function mouseReports(step: string, screen: string): string[] | undefined {
  const match = MOUSE.exec(step);
  if (match === null) return undefined;
  const [, kind, count = "1", anchor = "", dx = "0", dy = "0"] = match;
  const lines = screen.split("\n");
  const row = lines.findIndex((line) => line.includes(anchor));
  if (row === -1) throw new Error(`no "${anchor}" on the screen for the step ${step}`);
  const line = lines[row] ?? "";
  const at = `${displayWidth(line.slice(0, line.indexOf(anchor))) + Number(dx) + 1};${row + Number(dy) + 1}`;
  if (kind === "click") return [`\x1b[<0;${at}M\x1b[<0;${at}m`];
  return Array.from({ length: Number(count) }, () => `\x1b[<${kind === "wheel-up" ? 64 : 65};${at}M`);
}

export function parseSizes(text: string): [number, number][] {
  return text.split(",").map((size) => {
    const match = /^(\d+)x(\d+)$/.exec(size.trim());
    if (match === null) throw new Error(`a size is <columns>x<rows>, not "${size}"`);
    return [Number(match[1]), Number(match[2])];
  });
}

// While a tool call waits on a dialog, the engine blinks the bullet that leads its line, so two
// captures of an unchanged screen differ there; the settle check compares them with it masked.
export const withoutBlink = (screen: string): string => screen.replace(/^● /gm, "  ");

const isName = (value: unknown): value is string => typeof value === "string" && /^[\w.-]+$/.test(value);

export function parseView(text: string): View {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("a view must be a JSON object");
  const fields = new Map<string, unknown>(Object.entries(raw));
  const command = fields.get("command");
  const keys = fields.get("keys") ?? [];
  const mockScript = fields.get("mockScript") ?? null;
  const fixture = fields.get("fixture") ?? null;
  if (typeof command !== "string" || command === "") throw new Error('"command" must be a non-empty string');
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string" && key !== "")) {
    throw new Error('"keys" must be an array of non-empty strings');
  }
  if (mockScript !== null && !isName(mockScript)) throw new Error('"mockScript" must be a file name or null');
  if (fixture !== null && !isName(fixture)) throw new Error('"fixture" must be a directory name or null');
  return { command, keys, mockScript, fixture };
}

export function copyFixture(from: string, to: string, sharedPlans: string = SHARED_PLANS): void {
  cpSync(from, to, { recursive: true });
  const boulder = join(from, ".omca", "state", "boulder.json");
  const named = existsSync(boulder) ? [...readFileSync(boulder, "utf8").matchAll(/\{\{cwd\}\}\/plans\/([\w.-]+\.md)/g)] : [];
  for (const [, name = ""] of named) {
    const target = join(to, "plans", name);
    if (existsSync(target) || !existsSync(join(sharedPlans, name))) continue;
    mkdirSync(join(to, "plans"), { recursive: true });
    copyFileSync(join(sharedPlans, name), target);
  }
  const changed = new Date(Date.now() - FIXTURE_AGE_MS);
  for (const entry of readdirSync(to, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const text = readFileSync(path, "utf8");
    if (text.includes("{{cwd}}")) writeFileSync(path, text.replaceAll("{{cwd}}", to));
    utimesSync(path, changed, changed);
  }
}

export const sessionEnv = (): Record<string, string> => envWithout(/^(CLAUDE|ANTHROPIC|TMUX|OMCA)/);

/** The screen with the random suffix `mkdtemp` gave `scratch` replaced by as many X, so a capture does not change from run to run. */
export const maskScratch = (screen: string, scratch: string): string => screen.replaceAll(basename(scratch).slice(-MKDTEMP_SUFFIX), "X".repeat(MKDTEMP_SUFFIX));

// Padding keeps a line's width where a pane is drawn beside it, so the pane stays in its column.
const keepWidth = (masked: string, match: string, at: number, whole: string): string =>
  at + match.length === whole.length || whole[at + match.length] === "\n" ? masked : masked.padEnd(match.length);

const digitsOut = (text: string): string => text.replace(/\d/g, "N");

/**
 * The screen with the live session's own values fixed: the turn timer's line, whose verb Claude Code
 * picks at random, the Doctor's check time, a rating's time, a turn footer's engine cost, which
 * counts whatever background agents spent before the turn ended, the seconds a running agent has
 * run, in an OMCA lane and in Claude Code's task list, and a subagent's token count, whose requests
 * vary by a few hundred tokens from run to run.
 */
export const maskLive = (screen: string): string =>
  screen
    .replace(/\b((?:running|low|medium|high|xhigh|max) +)(\d+s)\b/g, (_match: string, lead: string, took: string) => `${lead}${digitsOut(took)}`)
    .replace(/\b\d+s · ↓/g, digitsOut)
    .replace(/\b\d+(?:\.\d+)?[kM]? tokens\b/g, digitsOut)
    .replace(/✻ \S+ for (\d+s) · done \d{1,2}:\d{2} [AP]M */g, (line: string, took: string, at: number, whole: string) =>
      keepWidth(`✻ Worked for ${took} · done HH:MM`, line, at, whole),
    )
    .replace(/\$\d+\.\d+([\u00a0 ])engine([\u00a0 ])cost */g, (match: string, a: string, b: string, at: number, whole: string) =>
      keepWidth(`$X.XX${a}engine${b}cost`, match, at, whole),
    )
    .replace(/checked \d\d:\d\d/g, "checked HH:MM")
    .replace(/\b(UP|DOWN)( +)\d\d-\d\d \d\d:\d\d/g, "$1$2MM-DD HH:MM");

export const mockSessionEnv = (port: number | undefined): string[] => [
  "-e", "DISABLE_AUTOUPDATER=1",
  "-e", `ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`,
  "-e", "ANTHROPIC_AUTH_TOKEN=mock-key",
];

export const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

// Claude Code clamps to 256 colors inside tmux unless CLAUDE_CODE_TMUX_TRUECOLOR is set, so a
// capture would hold approximations of the theme's colors. tmux's default TERM=screen drops
// italics, tmux passes 24-bit color to an attached terminal only with its RGB feature, and
// Claude Code shows a hint row when tmux has focus events off.
export const TRUECOLOR_ENV = ["-e", "CLAUDE_CODE_TMUX_TRUECOLOR=1", "-e", "COLORTERM=truecolor"] as const;
export const TERMINAL_OPTIONS = [
  "set-option", "-g", "default-terminal", "tmux-256color", ";",
  "set-option", "-ga", "terminal-features", "*:RGB", ";",
  "set-option", "-g", "focus-events", "on", ";",
] as const;

export class Tmux {
  readonly socket: string;
  readonly flags: readonly string[];
  readonly target = "visual";

  constructor(socket: string, flags: readonly string[] = []) {
    this.socket = socket;
    this.flags = flags;
  }

  run(args: readonly string[]): string {
    const result = Bun.spawnSync(["tmux", "-L", this.socket, ...this.flags, ...args], { env: sessionEnv() });
    if (result.exitCode !== 0) throw new Error(`tmux ${args[0]}: ${result.stderr.toString().trim()}`);
    return result.stdout.toString();
  }

  screen(): string {
    return this.run(["capture-pane", "-p", "-t", this.target]);
  }

  styledScreen(): string {
    return this.run(["capture-pane", "-p", "-e", "-N", "-t", this.target]);
  }

  send(...keys: string[]): void {
    this.run(["send-keys", "-t", this.target, ...keys]);
  }

  async waitFor(isReady: (screen: string) => boolean, timeoutMs: number, what: string): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = this.screen();
      if (isReady(screen)) return screen;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; the screen was:\n${screen}`);
      await Bun.sleep(POLL_MS);
    }
  }

  async settle(before: string): Promise<string> {
    const settled = withoutBlink(before);
    await this.waitFor((screen) => withoutBlink(screen) !== settled, CHANGE_TIMEOUT_MS, "a change").catch(() => before);
    let last = withoutBlink(this.screen());
    let stable = 0;
    return this.waitFor(
      (screen) => {
        const masked = withoutBlink(screen);
        stable = masked === last ? stable + 1 : 0;
        last = masked;
        return stable >= STABLE_POLLS;
      },
      SETTLE_TIMEOUT_MS,
      "the screen to settle",
    );
  }
}

// Claude Code writes its plugin data directory while it exits, so the scratch directory is
// removed only once the process is gone.
export async function exited(pid: number): Promise<void> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`claude (pid ${pid}) did not exit within ${EXIT_TIMEOUT_MS} ms`);
}

export async function teardown(...steps: Array<() => unknown>): Promise<void> {
  let failure: { error: unknown } | undefined;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure !== undefined) throw failure.error;
}

// Answers the folder-trust dialog when it shows, then waits for the input box and a still screen.
export async function reachPrompt(tmux: Tmux): Promise<void> {
  const first = await tmux.waitFor(
    (screen) => screen.includes(TRUST) || PROMPT.test(screen),
    START_TIMEOUT_MS,
    "the folder-trust dialog or the prompt",
  );
  if (first.includes(TRUST)) {
    let sentAt = 0;
    await tmux.waitFor(
      (screen) => {
        if (TRUST_SELECTED.test(screen)) return true;
        if (Date.now() - sentAt > RESEND_MS && TRUST_UNSELECTED.test(screen)) {
          tmux.send("Down");
          sentAt = Date.now();
        }
        return false;
      },
      START_TIMEOUT_MS,
      `"${TRUST}" to be selected`,
    );
    tmux.send("Enter");
  }
  await tmux.waitFor((screen) => PROMPT.test(screen), START_TIMEOUT_MS, "the input prompt");
  await tmux.settle(tmux.screen());
}

async function captureAt(view: View, root: string, cols: number, rows: number): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), `omca-visual-${cols}x${rows}-`));
  const cwd = join(scratch, "cwd");
  const config = join(scratch, "config");
  const script: Script =
    view.mockScript === null
      ? { main: [], subagent: [] }
      : parseScript(readFileSync(join(root, "scripts", `${view.mockScript}.json`), "utf8"));
  const mock = startServer({ port: 0, script });
  const tmux = new Tmux(`omca-visual-${process.pid}`);
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
    if (view.fixture === null) mkdirSync(cwd);
    else copyFixture(join(root, "fixtures", view.fixture), cwd);
    mkdirSync(config);
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    writeFileSync(join(config, "settings.json"), JSON.stringify({ tui: "fullscreen", prefersReducedMotion: true }));
    const claude = `claude --plugin-dir ${quote(REPO)} --session-id ${SESSION_ID} --permission-mode default`;
    tmux.run([
      ...TERMINAL_OPTIONS,
      "new-session", "-d", "-s", tmux.target, "-x", String(cols), "-y", String(rows), "-c", cwd,
      "-e", `CLAUDE_CONFIG_DIR=${config}`,
      ...TRUECOLOR_ENV,
      ...mockSessionEnv(mock.port),
      claude,
    ]);
    claudePid = Number(tmux.run(["display-message", "-p", "-t", tmux.target, "#{pane_pid}"]).trim());
    await reachPrompt(tmux);

    tmux.send("-l", view.command);
    const typed = await tmux.waitFor(
      (screen) => screen.includes(view.command.slice(0, 20)),
      START_TIMEOUT_MS,
      "the command to be typed",
    );
    tmux.send("Enter");
    let screen = await tmux.settle(typed);
    for (const key of view.keys) {
      for (const report of mouseReports(key, screen) ?? []) {
        tmux.send("-l", report);
        screen = await tmux.settle(screen);
      }
      if (MOUSE.test(key)) continue;
      tmux.send(key);
      screen = await tmux.settle(screen);
    }
    return maskLive(maskScratch(screen, scratch));
  } finally {
    release();
    await stop();
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string", default: join(REPO, "tests", "mod", "visual") },
      sizes: { type: "string" },
      out: { type: "string" },
    },
  });
  const [name] = positionals;
  if (name === undefined || !isName(name)) {
    console.error("usage: bun scripts/qa/visual.ts <view> [--root <dir>] [--sizes 80x24,160x30] [--out <dir>]");
    process.exit(2);
  }
  const view = parseView(readFileSync(join(values.root, `${name}.json`), "utf8"));
  const sizes = values.sizes === undefined ? SIZES : parseSizes(values.sizes);
  const dir = values.out ?? values.root;
  mkdirSync(dir, { recursive: true });
  for (const [cols, rows] of sizes) {
    const out = join(dir, values.sizes === undefined ? `${name}-${cols}.txt` : `${name}-${cols}x${rows}.txt`);
    writeFileSync(out, await captureAt(view, values.root, cols, rows));
    console.log(out);
  }
}
