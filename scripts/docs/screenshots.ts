#!/usr/bin/env bun
// Captures the README screens from real Claude Code sessions against the scripted mock model. Each
// session runs in tmux, and kitty draws it on a private Xvfb display, so every image is a pixel
// grab of a real terminal: a PNG still, or a GIF recorded while the scripted keys are typed.
//
// Usage: bun scripts/docs/screenshots.ts [<name>...] [--out <dir>]
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";
import { packageTree } from "../package.ts";
import { type Script, startServer } from "../qa/mock-model.ts";
import { exited, mockSessionEnv, quote, reachPrompt, sessionEnv, teardown, TERMINAL_OPTIONS, Tmux, TRUECOLOR_ENV } from "../qa/visual.ts";
import { assertPrivate, machineValues, SCRATCH_PREFIX } from "./privacy.ts";

const REPO = join(import.meta.dir, "..", "..");
const FIXTURE = join(import.meta.dir, "fixtures", "acme-app");
export const ASSET_DIR = join(REPO, ".github", "assets");
const SOCKET = "omca-shots";
const KITTY_CLASS = "omca-shots";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const PLAN_NAME = "checkout-redesign";
const POLL_MS = 150;
const READY_TIMEOUT_MS = 30_000;
const WINDOW_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 120_000;
export const FONT_FAMILIES = ["JetBrains Mono", "JetBrainsMono Nerd Font Mono"] as const;
const FONT_SIZE = 14;
const PADDING = 12;
const SCREEN = "3840x2160x24";
const FIRST_DISPLAY = 100;
const RECORD_FPS = 15;
const GIF_FPS = 10;
const TYPE_MS = 70;
const KEY_PAUSE_MS = 1_400;
const HOLD_MS = 2_500;
// kitty paints a tmux redraw on its next frame; this covers a few frames at its default 60 Hz.
const PAINT_MS = 400;

export type Shot = {
  name: string;
  format: "png" | "gif";
  cols: number;
  rows: number;
  command: string;
  keys: readonly string[];
  script: Script;
  ready: (screen: string) => boolean;
  // "pane" keeps only the docked OMCA pane, so its text stays readable at README width.
  crop?: "pane";
  settings?: Record<string, unknown>;
};

const text = (value: string) => ({ type: "text" as const, text: value });
const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool_use" as const, name, input });
const bash = (command: string, description: string) => tool("Bash", { command, description });
const agent = (type: string, description: string, prompt: string) =>
  tool("Agent", { subagent_type: `oh-my-claudeagent:${type}`, description, prompt, run_in_background: true });
const executor = (description: string, prompt: string) => agent("executor", description, prompt);

// The justfile's watch recipe sleeps, so an agent that reaches it keeps running through the capture.
const WATCH_SUMMARY = bash("just watch summary", "Run the summary tests in watch mode");
const TASK_7 = executor("Wire the order summary panel", "Task 7: wire the order summary panel into the payment step.");
const PLAN_SCRIPT: Script = {
  main: [
    { content: [text("Task 7 is next: tasks 1 and 6 are done. I will hand it to the executor."), TASK_7] },
    { content: [text("The executor is on task 7. Tasks 8, 9 and 11 are open as well.")] },
  ],
  subagent: [
    { content: [tool("Read", { file_path: "src/steps/summary.ts" })] },
    { content: [tool("Grep", { pattern: "total", path: "src/cart" })] },
    { content: [WATCH_SUMMARY] },
  ],
};
const NO_SCRIPT: Script = { main: [], subagent: [] };
const planReady = (screen: string) => screen.includes("executor on 7") && screen.includes("UNPROVEN") && screen.includes("enter open");
const GUARD_SCRIPT: Script = {
  main: [{ content: [bash("rm -rf build", "Remove the build output")] }, { content: [text("The build is clean.")] }],
  subagent: [],
};
const guardReady = (screen: string) => /^● Removing/m.test(screen) && screen.includes("OMCA held this command");

export const SHOTS: readonly Shot[] = [
  {
    name: "hero",
    format: "png",
    cols: 200,
    rows: 50,
    command: "Pick up the next task on the plan",
    keys: ["/omca plan", "Enter"],
    script: PLAN_SCRIPT,
    ready: (screen) => planReady(screen) && screen.includes("7. Wire the order summary panel"),
  },
  {
    name: "band",
    format: "png",
    cols: 120,
    rows: 30,
    command: "Run the tests",
    keys: [],
    script: {
      main: [{ content: [bash("just test", "Run the tests"), TASK_7] }, { content: [text("The tests pass, and the executor is on task 7.")] }],
      subagent: [{ content: [tool("Read", { file_path: "src/steps/summary.ts" })] }, { content: [WATCH_SUMMARY] }],
    },
    ready: (screen) => screen.includes("evidence not logged") && screen.includes("1 running"),
  },
  {
    name: "plan",
    format: "png",
    cols: 214,
    rows: 44,
    command: "Pick up the next task on the plan",
    keys: ["/omca plan", "Enter", "Up"],
    script: PLAN_SCRIPT,
    ready: (screen) => planReady(screen) && screen.includes("6. Build the payment step"),
    crop: "pane",
  },
  {
    name: "evidence",
    format: "png",
    cols: 214,
    rows: 32,
    command: "/omca",
    keys: ["3"],
    script: NO_SCRIPT,
    ready: (screen) => screen.includes("MISSING") && screen.includes("‹masked›"),
    crop: "pane",
  },
  {
    name: "agents",
    format: "png",
    cols: 214,
    rows: 22,
    command: "Start the open checkout tasks",
    keys: ["/omca", "Enter"],
    // Subagents share one queue of scripted turns, so explore finishes and the first executor
    // reaches its watch before the second starts, which fixes which agent draws which turn.
    script: {
      main: [
        {
          content: [
            text("Task 8 needs the current error messages first; explore will map them."),
            agent("explore", "Map the validation messages", "Task 8: list every validation message the address and card forms build today."),
          ],
        },
        { content: [text("Explore is mapping the messages.")] },
        { content: [text("Explore mapped the messages. Tasks 7 and 9 can start now."), TASK_7] },
        { content: [bash("sleep 3", "Let the first executor settle")] },
        { content: [executor("Persist the draft order", "Task 9: save the draft order on every step so a reload keeps it.")] },
        { content: [text("Two executors are running, on tasks 7 and 9.")] },
      ],
      subagent: [
        { content: [tool("Grep", { pattern: "error", path: "src/forms" })] },
        { content: [tool("Read", { file_path: "src/forms/card.ts" })] },
        { content: [text("The forms build seven messages: four in src/forms/address.ts and three in src/forms/card.ts.")] },
        { content: [tool("Read", { file_path: "src/steps/summary.ts" })] },
        { content: [tool("Grep", { pattern: "total", path: "src/cart" })] },
        { content: [WATCH_SUMMARY] },
        { content: [tool("Read", { file_path: "src/cart/totals.ts" })] },
        { content: [tool("Glob", { pattern: "src/cart/*.ts" })] },
        { content: [bash("just watch draft", "Run the draft order tests in watch mode")] },
      ],
    },
    ready: (screen) => screen.includes("just watch summary") && screen.includes("just watch draft") && screen.includes("✓ explore"),
    crop: "pane",
  },
  { name: "guard", format: "png", cols: 120, rows: 26, command: "Clean the build", keys: [], script: GUARD_SCRIPT, ready: guardReady },
  {
    name: "doctor",
    format: "png",
    cols: 214,
    rows: 26,
    command: "Say hello",
    keys: ["/omca doctor", "Enter"],
    script: { main: [{ content: [text("Hello.")] }], subagent: [] },
    ready: (screen) => screen.includes("checked") && screen.includes("WARN"),
    crop: "pane",
    // An effort cap below oracle's declared xhigh is a real WARN the doctor explains.
    settings: { maxEffortLevel: "high" },
  },
  {
    name: "statusline",
    format: "png",
    cols: 160,
    rows: 34,
    command: "Run the type and lint checks in parallel",
    keys: [],
    script: {
      main: [
        {
          content: [
            text("I will run both checks at once."),
            executor("Check the types", "Run the type checker."),
            executor("Check the lint rules", "Run the linter."),
          ],
        },
        { content: [text("Both checks are running.")] },
      ],
      subagent: [
        { content: [bash("sleep 25", "Run the type checker")] },
        { content: [bash("sleep 25", "Run the linter")] },
        { content: [text("The type check passed.")] },
        { content: [text("The lint check passed.")] },
      ],
    },
    ready: (screen) => screen.includes("Check the lint rules · "),
  },
  {
    name: "pane-tour",
    format: "gif",
    cols: 160,
    rows: 42,
    command: "Pick up the next task on the plan",
    keys: ["/omca plan", "Enter", "Down", "Enter", "1", "3", "2"],
    script: PLAN_SCRIPT,
    ready: (screen) => screen.includes("8. Add inline validation errors") && screen.includes("b: Board"),
  },
  { name: "guard-dialog", format: "gif", cols: 120, rows: 26, command: "Clean the build", keys: [], script: GUARD_SCRIPT, ready: guardReady },
];

function run(argv: readonly string[], env: Record<string, string>): string {
  const { exitCode, stdout, stderr } = Bun.spawnSync([...argv], { env, stdout: "pipe", stderr: "pipe", timeout: RUN_TIMEOUT_MS });
  if (exitCode !== 0) throw new Error(`${argv[0]} ${argv[1] ?? ""} exited ${exitCode}: ${stderr.toString().trim()}`);
  return stdout.toString();
}

async function until<T>(probe: () => T | undefined, what: string, timeoutMs = WINDOW_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(POLL_MS);
  }
}

function git(cwd: string, home: string, ...args: string[]): void {
  run(["git", "-C", cwd, ...args], { ...sessionEnv(), HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const EXECUTOR = "oh-my-claudeagent:executor";
const SISYPHUS = "oh-my-claudeagent:sisyphus";
const HEPHAESTUS = "oh-my-claudeagent:hephaestus";

// Each run's age before the capture, so the day groups and the times beside them read as recent
// whenever the script runs. The newest test passed after every task file but task 7's changed,
// which makes tasks 1 to 6 PROVEN and task 7 UNPROVEN.
const LEDGER: readonly (readonly [age: number, type: string, command: string, exitCode: number, snippet: string, by: string])[] = [
  [50 * HOUR, "build", "bun run build", 0, "built 38 modules in 1.1 s", EXECUTOR],
  [49.5 * HOUR, "test", "bun test src/cart", 1, "(fail) tax on a discounted line\n  Expected: 263\n  Received: 315\n 11 pass\n 1 fail", EXECUTOR],
  [49 * HOUR, "test", "bun test src/cart", 0, " 12 pass\n 0 fail\nRan 12 tests across 2 files. [41.00ms]", EXECUTOR],
  [47 * HOUR, "lint", "just lint", 0, "Found 0 warnings and 0 errors.", EXECUTOR],
  [27 * HOUR, "test", "bun test src/forms", 0, " 21 pass\n 0 fail\nRan 21 tests across 2 files. [38.00ms]", EXECUTOR],
  [25.5 * HOUR, "lint", "just typecheck", 1, "src/steps/address.ts:4:3 - error TS2322: Type 'string' is not assignable to type 'boolean'.", HEPHAESTUS],
  [25 * HOUR, "lint", "just typecheck", 0, "tsc --noEmit: no errors", HEPHAESTUS],
  [24.5 * HOUR, "build", "bun run build", 0, "built 41 modules in 1.2 s", EXECUTOR],
  [23 * HOUR, "final_verification", "just ci", 1, "INCOMPLETE: 9 of 14 tasks are open\nlint, typecheck and test pass; the e2e suite is not written yet", SISYPHUS],
  [170 * MINUTE, "test", "bun test src/steps", 1, "(fail) a declined card keeps the cart\n  Expected: 3 items\n  Received: 0 items\n 17 pass\n 1 fail", EXECUTOR],
  [140 * MINUTE, "test", "bun test src/steps", 0, " 18 pass\n 0 fail\nRan 18 tests across 3 files. [212.00ms]", EXECUTOR],
  [100 * MINUTE, "lint", "just lint", 0, "Found 0 warnings and 0 errors.", EXECUTOR],
  [45 * MINUTE, "test", "bun test", 0, " 142 pass\n 0 fail\nRan 142 tests across 14 files. [1.84s]", EXECUTOR],
  [
    20 * MINUTE,
    "manual",
    'PAYMENTS_API_KEY="fake-sandbox-key" bun run smoke:payment',
    0,
    "card ending 0002 declined: cart kept, 3 items\ncard ending 4242 accepted: draft order saved\nsmoke passed in 2.8 s",
    SISYPHUS,
  ],
];

const FILE_AGES: readonly (readonly [age: number, files: readonly string[]])[] = [
  [51 * HOUR, ["src/cart/totals.ts", "src/cart/tax.ts", "config/tax.json"]],
  [28 * HOUR, ["src/forms/address.ts", "src/forms/card.ts"]],
  [26 * HOUR, ["src/steps/address.ts"]],
  [3 * HOUR, ["src/steps/payment.ts"]],
  [6 * MINUTE, ["src/steps/summary.ts", "src/steps/summary.spec.ts"]],
];

function writeProject(project: string, home: string): void {
  cpSync(FIXTURE, project, { recursive: true });
  const plan = join(project, "plans", `${PLAN_NAME}.md`);
  mkdirSync(join(project, ".claude"), { recursive: true });
  mkdirSync(join(project, ".omca", "state"), { recursive: true });
  mkdirSync(join(project, ".omca", "evidence"), { recursive: true });
  writeFileSync(
    join(project, ".claude", "settings.json"),
    JSON.stringify({
      plansDirectory: join(project, "plans"),
      permissions: { defaultMode: "default", allow: ["Bash(just test)", "Bash(just watch *)", "Bash(sleep *)"] },
    }),
  );
  writeFileSync(
    join(project, ".omca", "state", "boulder.json"),
    JSON.stringify({
      plans: { [PLAN_NAME]: { active_plan: plan, started_at: "2026-10-02T08:00:00Z", session_ids: [SESSION_ID], agent: "sisyphus" } },
      bindings: { [SESSION_ID]: { plan_name: PLAN_NAME, bound_at: 1790928000 } },
    }),
  );
  writeFileSync(join(project, ".gitignore"), ".omca/\n.claude/\n");
  git(project, home, "init", "-q", "-b", "main");
  git(project, home, "config", "user.name", "Acme Dev");
  git(project, home, "config", "user.email", "dev@example.invalid");
  git(project, home, "add", "-A");
  git(project, home, "commit", "-q", "-m", "Initial commit");
  writeFileSync(join(project, "src", "steps", "summary.ts"), 'import { total } from "../cart/totals.ts";\n\nexport const summaryPanel = { title: "Order summary", total };\n');
  writeFileSync(join(project, "src", "steps", "payment.ts"), 'export const paymentStep = (declined?: string) => ({ title: "Payment", keepCart: true, alert: declined ?? "" });\n');
  writeFileSync(join(project, "src", "steps", "summary.spec.ts"), 'import { expect, test } from "bun:test";\n\ntest.todo("lists items, tax and shipping");\n');
  git(project, home, "add", "src/steps/summary.spec.ts");

  const now = Date.now();
  const entries = LEDGER.map(([age, type, command, exitCode, snippet, by]) => ({
    type,
    command,
    exit_code: exitCode,
    output_snippet: snippet,
    timestamp: new Date(now - age).toISOString(),
    verified_by: by,
  }));
  const ledger = join(project, ".omca", "evidence", "verification-evidence.json");
  writeFileSync(ledger, JSON.stringify({ entries }, null, 2));
  // The band counts a ledger changed within seconds of a verification as its evidence.
  const lastLogged = new Date(now - Math.min(...LEDGER.map(([age]) => age)));
  utimesSync(ledger, lastLogged, lastLogged);
  for (const [age, files] of FILE_AGES) {
    const at = new Date(now - age);
    for (const file of files) utimesSync(join(project, file), at, at);
  }
}

function findFont(env: Record<string, string>): { family: string; dir: string } {
  for (const family of FONT_FAMILIES) {
    const file = run(["fc-list", "-f", "%{file}\n", `:family=${family}:style=Regular`], env).split("\n")[0];
    if (file) return { family, dir: dirname(file) };
  }
  throw new Error(`no terminal font found; install one of: ${FONT_FAMILIES.join(", ")}`);
}

// A fontconfig file that sees the system fonts and the chosen font's directory, so kitty runs
// with a scratch HOME and never reads the maintainer's own font or terminal configuration.
function fontConfig(fontDir: string, cacheDir: string): string {
  return `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${fontDir}</dir><cachedir>${cacheDir}</cachedir></fontconfig>\n`;
}

// A private display numbered well above the ones a desktop session takes.
function freeDisplay(): string {
  for (let number = FIRST_DISPLAY; number < FIRST_DISPLAY + 100; number += 1) {
    if (!existsSync(`/tmp/.X${number}-lock`) && !existsSync(`/tmp/.X11-unix/X${number}`)) return `:${number}`;
  }
  throw new Error("no free X display number");
}

function offDesktop(env: Record<string, string>, display: string): Record<string, string> {
  const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, WAYLAND_SOCKET: _socket, ...rest } = env;
  return { ...rest, DISPLAY: display };
}

async function stop(child: Subprocess): Promise<void> {
  child.kill();
  await child.exited;
}

type Window = { x: number; y: number; width: number; height: number };

function windowOf(env: Record<string, string>): Window | undefined {
  const id = Bun.spawnSync(["xdotool", "search", "--onlyvisible", "--class", KITTY_CLASS], { env, stdout: "pipe", stderr: "ignore" }).stdout.toString().split("\n")[0];
  if (!id) return undefined;
  const geometry = Object.fromEntries(
    run(["xdotool", "getwindowgeometry", "--shell", id], env)
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  const width = Number(geometry["WIDTH"]);
  return width > 1 ? { x: Number(geometry["X"]), y: Number(geometry["Y"]), width, height: Number(geometry["HEIGHT"]) } : undefined;
}

// The docked pane begins at the border column its tab row opens with and ends at the first row
// without that border. tmux prints one character per cell here, since the rows hold no wide glyphs.
function paneArea(screen: string, window: Window, shot: Shot): Window {
  const rows = screen.split("\n").map((row) => [...row]);
  const column = rows[0]?.indexOf("│") ?? -1;
  if (column < 0) throw new Error(`${shot.name}: the screen shows no docked pane to crop to`);
  const end = rows.findIndex((row) => row[column] !== "│");
  // kitty draws whole cells from the top-left padding and leaves any spare pixels at the bottom
  // and right, so the window size divided by the grid overstates a cell.
  const cellWidth = Math.floor((window.width - 2 * PADDING) / shot.cols);
  const cellHeight = Math.floor((window.height - 2 * PADDING) / shot.rows);
  // From the middle of the border cell, where kitty draws the line, so no transcript glyph that
  // overflows its cell shows; to the right padding, so the close mark in the last cell stays whole.
  const left = PADDING + column * cellWidth + Math.floor(cellWidth / 2) - 1;
  return {
    x: window.x + left,
    y: window.y + PADDING,
    width: 2 * PADDING + shot.cols * cellWidth - left,
    height: end * cellHeight,
  };
}

function clientSize(tmux: Tmux): string | undefined {
  return tmux.run(["list-clients", "-F", "#{client_width}x#{client_height}"]).trim().split("\n")[0] || undefined;
}

function toGif(raw: string, out: string, env: Record<string, string>): void {
  const palette = `fps=${GIF_FPS},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
  run(["ffmpeg", "-loglevel", "error", "-y", "-i", raw, "-vf", palette, "-loop", "0", out], env);
}

export async function captureShot(shot: Shot, outDir: string): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  const home = join(scratch, "home");
  const project = join(home, "acme-app");
  const config = join(home, ".claude");
  const plugin = join(home, "oh-my-claudeagent");
  const forbidden = machineValues(scratch);
  const env = sessionEnv();
  const mock = startServer({ port: 0, script: shot.script });
  const tmux = new Tmux(SOCKET, ["-f", "/dev/null"]);
  const children: Subprocess[] = [];
  let claudePid: number | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  try {
    mkdirSync(project, { recursive: true });
    mkdirSync(config);
    mkdirSync(join(scratch, "tmp"));
    writeProject(project, home);
    packageTree(REPO, plugin);
    const bun = Bun.which("bun") ?? "bun";
    const statusline = (entry: string) => `${quote(bun)} ${quote(join(plugin, "statusline", entry))}`;
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark" }));
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify({
        tui: "fullscreen",
        statusLine: { type: "command", command: statusline("main.ts"), padding: 1, refreshInterval: 5, hideVimModeIndicator: true },
        subagentStatusLine: { type: "command", command: statusline("subagent.ts") },
        ...shot.settings,
      }),
    );

    const font = findFont(env);
    const display = freeDisplay();
    const screenEnv = offDesktop(env, display);
    const xvfb = Bun.spawn(["Xvfb", display, "-displayfd", "1", "-screen", "0", SCREEN, "-dpi", "96", "-nolisten", "tcp"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(xvfb);
    const { value: ready } = await xvfb.stdout.getReader().read();
    if (ready === undefined) throw new Error(`Xvfb did not start on ${display}: ${(await new Response(xvfb.stderr).text()).trim()}`);

    tmux.run([
      ...TERMINAL_OPTIONS,
      "new-session", "-d", "-s", tmux.target, "-x", String(shot.cols), "-y", String(shot.rows), "-c", project,
      "-e", `HOME=${home}`,
      "-e", `CLAUDE_CONFIG_DIR=${config}`,
      "-e", `TMPDIR=${join(scratch, "tmp")}`,
      ...mockSessionEnv(mock.port),
      ...TRUECOLOR_ENV,
      "-e", "OMCA_DISABLED_HOOKS=stop-gates",
      `claude --plugin-dir ${quote(plugin)} --session-id ${SESSION_ID}`,
      // kitty's attached client would otherwise take a row for the tmux status bar, and Claude Code
      // shows a hint row when tmux has mouse events off.
      ";", "set-option", "-g", "status", "off",
      ";", "set-option", "-g", "mouse", "on",
    ]);
    claudePid = Number(tmux.run(["display-message", "-p", "-t", tmux.target, "#{pane_pid}"]).trim());

    const kittyDir = join(scratch, "kitty");
    mkdirSync(kittyDir);
    writeFileSync(join(kittyDir, "fonts.conf"), fontConfig(font.dir, join(kittyDir, "fontconfig")));
    const kitty = Bun.spawn(
      [
        "kitty", "--config", "NONE", "--class", KITTY_CLASS,
        "-o", `font_family=${font.family}`,
        "-o", `font_size=${FONT_SIZE}`,
        "-o", `initial_window_width=${shot.cols}c`,
        "-o", `initial_window_height=${shot.rows}c`,
        "-o", "remember_window_size=no",
        "-o", `window_padding_width=${PADDING}`,
        "-o", "cursor_blink_interval=0",
        "-o", "linux_display_server=x11",
        // kitty widens a symbol the font lacks over the space after it, which ran the last cell of
        // each progress bar into the count beside it.
        "-o", "narrow_symbols=U+25A0-U+25FF 1",
        "tmux", "-L", SOCKET, "-f", "/dev/null", "attach-session", "-t", tmux.target,
      ],
      {
        env: { ...screenEnv, HOME: kittyDir, XDG_CONFIG_HOME: join(kittyDir, "config"), XDG_CACHE_HOME: join(kittyDir, "cache"), FONTCONFIG_FILE: join(kittyDir, "fonts.conf") },
        stdout: "ignore",
        stderr: Bun.file(join(kittyDir, "kitty.log")),
      },
    );
    children.push(kitty);
    const window = await until(() => windowOf(screenEnv), `the kitty window on ${display} (log: ${join(kittyDir, "kitty.log")})`);
    const size = await until(() => clientSize(tmux), "kitty to attach to the tmux session");
    if (size !== `${shot.cols}x${shot.rows}`) throw new Error(`${shot.name}: kitty opened a ${size} grid, not ${shot.cols}x${shot.rows}`);

    await reachPrompt(tmux);
    const raw = join(scratch, `${shot.name}.raw.${shot.format === "gif" ? "mkv" : "png"}`);
    const out = join(outDir, `${shot.name}.${shot.format}`);
    const isClip = shot.format === "gif";
    let leak: unknown;
    let recorder: Subprocess<"pipe", "ignore", "pipe"> | undefined;
    if (isClip) {
      assertPrivate(tmux.screen(), forbidden);
      recorder = Bun.spawn(
        [
          "ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(RECORD_FPS),
          "-video_size", `${window.width}x${window.height}`, "-i", `${display}+${window.x},${window.y}`,
          "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0", raw,
        ],
        { env: screenEnv, stdin: "pipe", stdout: "ignore", stderr: "pipe" },
      );
      children.push(recorder);
      watch = setInterval(() => {
        try {
          assertPrivate(tmux.screen(), forbidden);
        } catch (error) {
          leak ??= error;
        }
      }, POLL_MS);
      await Bun.sleep(KEY_PAUSE_MS);
      for (const char of shot.command) {
        tmux.send("-l", char);
        await Bun.sleep(TYPE_MS);
      }
    } else {
      tmux.send("-l", shot.command);
    }
    let screen = await tmux.waitFor((current) => current.includes(shot.command.slice(0, 20)), READY_TIMEOUT_MS, "the command to be typed");
    if (isClip) await Bun.sleep(KEY_PAUSE_MS / 2);
    tmux.send("Enter");
    screen = await tmux.settle(screen);
    for (const key of shot.keys) {
      if (isClip) await Bun.sleep(KEY_PAUSE_MS);
      tmux.send(key);
      screen = await tmux.settle(screen);
    }
    await until(
      () => {
        const current = tmux.screen();
        if (current.includes("did not load")) throw new Error(`${shot.name}: the plugin snapshot did not load`);
        return shot.ready(current) ? true : undefined;
      },
      `${shot.name} to reach its state`,
      READY_TIMEOUT_MS,
    ).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; the screen was:\n${tmux.screen()}`);
    });

    if (recorder !== undefined) {
      await Bun.sleep(HOLD_MS);
      clearInterval(watch);
      recorder.stdin.write("q");
      await recorder.stdin.end();
      const code = await recorder.exited;
      if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${(await new Response(recorder.stderr).text()).trim()}`);
      if (leak !== undefined) throw leak;
      assertPrivate(tmux.screen(), forbidden);
      toGif(raw, out, env);
    } else {
      await Bun.sleep(PAINT_MS);
      const shown = tmux.screen();
      assertPrivate(shown, forbidden);
      const area = shot.crop === "pane" ? paneArea(shown, window, shot) : window;
      run(["import", "-silent", "-window", "root", "-crop", `${area.width}x${area.height}+${area.x}+${area.y}`, "+repage", raw], screenEnv);
      assertPrivate(tmux.screen(), forbidden);
      run(["magick", raw, "-strip", "-define", "png:compression-level=9", "-define", "png:exclude-chunks=date,time", out], env);
    }
    return out;
  } finally {
    await teardown(
      () => clearInterval(watch),
      () => Bun.spawnSync(["tmux", "-L", SOCKET, "-f", "/dev/null", "kill-server"], { env }),
      () => claudePid !== undefined && exited(claudePid),
      ...children.reverse().map((child) => () => stop(child)),
      () => mock.stop(true),
      () => rmSync(scratch, { recursive: true, force: true }),
    );
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string", default: ASSET_DIR } },
  });
  const chosen = positionals.length === 0 ? SHOTS : SHOTS.filter((shot) => positionals.includes(shot.name));
  const unknown = positionals.filter((name) => !SHOTS.some((shot) => shot.name === name));
  if (unknown.length > 0 || chosen.length === 0) {
    console.error(`usage: bun scripts/docs/screenshots.ts [<name>...] [--out <dir>]\nnames: ${SHOTS.map((shot) => shot.name).join(" ")}`);
    process.exit(2);
  }
  mkdirSync(values.out, { recursive: true });
  for (const shot of chosen) console.log(await captureShot(shot, values.out));
}
