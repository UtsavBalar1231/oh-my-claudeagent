#!/usr/bin/env bun
// Captures the README screens from real Claude Code sessions against the scripted mock model. Each
// session runs in tmux, and kitty draws it on a private Xvfb display, so every image is a pixel
// grab of a real terminal: a PNG still, or a GIF recorded while the scripted keys are typed.
//
// Usage: bun scripts/docs/screenshots.ts [<name>...] [--out <dir>]
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";
import { packageTree } from "../package.ts";
import { type Script, startServer } from "../qa/mock-model.ts";
import { exited, mockSessionEnv, quote, reachPrompt, sessionEnv, teardown, Tmux } from "../qa/visual.ts";
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
};

const text = (value: string) => ({ type: "text" as const, text: value });
const bash = (command: string, description: string) => ({ type: "tool_use" as const, name: "Bash", input: { command, description } });
const executor = (description: string, prompt: string) => ({
  type: "tool_use" as const,
  name: "Agent",
  input: { subagent_type: "oh-my-claudeagent:executor", description, prompt },
});

const NO_SCRIPT: Script = { main: [], subagent: [] };
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
    script: {
      main: [
        { content: [text("Task 7 is next. I will hand it to the executor."), executor("Wire the order summary panel", "Wire the order summary panel into the payment step.")] },
        { content: [text("The executor is working on task 7.")] },
        { content: [text("The executor finished task 7: the order summary panel is wired into the payment step. It is ready for review.")] },
      ],
      subagent: [{ content: [text("Wired the order summary panel into the payment step.")] }],
    },
    ready: (screen) => screen.includes("Wire the order summary panel") && screen.includes("tasks done"),
  },
  {
    name: "band",
    format: "png",
    cols: 120,
    rows: 40,
    command: "Run the tests",
    keys: [],
    script: { main: [{ content: [bash("just test", "Run the tests")] }, { content: [text("The tests ran.")] }], subagent: [] },
    ready: (screen) => screen.includes("evidence not logged"),
  },
  {
    name: "plan",
    format: "png",
    cols: 120,
    rows: 30,
    command: "/omca plan",
    keys: ["Enter"],
    script: NO_SCRIPT,
    ready: (screen) => screen.includes("Depends: 6"),
  },
  { name: "guard", format: "png", cols: 120, rows: 26, command: "Clean the build", keys: [], script: GUARD_SCRIPT, ready: guardReady },
  {
    name: "doctor",
    format: "png",
    cols: 120,
    rows: 46,
    command: "Say hello",
    keys: ["/omca doctor", "Enter"],
    script: { main: [{ content: [text("Hello.")] }], subagent: [] },
    ready: (screen) => screen.includes("checked"),
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
    cols: 120,
    rows: 30,
    command: "/omca plan",
    keys: ["Enter", "n", "1", "3", "2"],
    script: NO_SCRIPT,
    ready: (screen) => screen.includes("8. Add inline validation errors") && screen.includes("Depends: 7"),
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

function writeProject(project: string, home: string): void {
  cpSync(FIXTURE, project, { recursive: true });
  const plan = join(project, "plans", `${PLAN_NAME}.md`);
  mkdirSync(join(project, ".claude"), { recursive: true });
  mkdirSync(join(project, ".omca", "state"), { recursive: true });
  writeFileSync(
    join(project, ".claude", "settings.json"),
    JSON.stringify({ plansDirectory: join(project, "plans"), permissions: { defaultMode: "default", allow: ["Bash(just test)", "Bash(sleep *)"] } }),
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
  writeFileSync(join(project, "src", "cart.ts"), "export const total = (items: number[]) => items.reduce((a, b) => a + b, 0);\nexport const count = (items: number[]) => items.length;\n");
  writeFileSync(join(project, "src", "checkout.ts"), 'export const checkout = () => "done";\n');
  writeFileSync(join(project, "src", "summary.ts"), "export const summary = () => [];\n");
  git(project, home, "add", "src/summary.ts");
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
      "new-session", "-d", "-s", tmux.target, "-x", String(shot.cols), "-y", String(shot.rows), "-c", project,
      "-e", `HOME=${home}`,
      "-e", `CLAUDE_CONFIG_DIR=${config}`,
      "-e", `TMPDIR=${join(scratch, "tmp")}`,
      ...mockSessionEnv(mock.port),
      "-e", "COLORTERM=truecolor",
      "-e", "OMCA_DISABLED_HOOKS=stop-gates",
      `claude --plugin-dir ${quote(plugin)} --session-id ${SESSION_ID}`,
      // kitty's attached client would otherwise take a row for the tmux status bar, and Claude Code
      // shows a hint row when tmux has mouse or focus events off.
      ";", "set-option", "-g", "status", "off",
      ";", "set-option", "-g", "mouse", "on",
      ";", "set-option", "-g", "focus-events", "on",
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
      assertPrivate(tmux.screen(), forbidden);
      run(["import", "-silent", "-window", "root", "-crop", `${window.width}x${window.height}+${window.x}+${window.y}`, "+repage", raw], screenEnv);
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
