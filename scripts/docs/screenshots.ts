#!/usr/bin/env bun
// Captures the README screens from real Claude Code sessions inside tmux, against the scripted
// mock model, and writes each one as a masked ANSI file under .github/assets/src/.
//
// Usage: bun scripts/docs/screenshots.ts [<name>...] [--out <dir>]
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { packageTree } from "../package.ts";
import { type Script, startServer } from "../qa/mock-model.ts";
import { exited, mockSessionEnv, quote, reachPrompt, sessionEnv, Tmux } from "../qa/visual.ts";
import { formatAnsi, padRow, parseAnsi } from "./ansi.ts";
import { maskRows } from "./mask.ts";

const REPO = join(import.meta.dir, "..", "..");
const FIXTURE = join(import.meta.dir, "fixtures", "acme-app");
export const SOURCE_DIR = join(REPO, ".github", "assets", "src");
const SOCKET = "omca-shots";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const PLAN_NAME = "checkout-redesign";
const POLL_MS = 150;
const READY_TIMEOUT_MS = 30_000;

export type Shot = {
  name: string;
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

export const SHOTS: readonly Shot[] = [
  {
    name: "hero",
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
    cols: 120,
    rows: 40,
    command: "Run the tests",
    keys: [],
    script: { main: [{ content: [bash("just test", "Run the tests")] }, { content: [text("The tests ran.")] }], subagent: [] },
    ready: (screen) => screen.includes("evidence not logged"),
  },
  {
    name: "plan",
    cols: 120,
    rows: 30,
    command: "/omca plan",
    keys: ["Enter"],
    script: NO_SCRIPT,
    ready: (screen) => screen.includes("Depends: 6"),
  },
  {
    name: "guard",
    cols: 120,
    rows: 26,
    command: "Clean the build",
    keys: [],
    script: {
      main: [{ content: [bash("rm -rf build", "Remove the build output")] }, { content: [text("The build is clean.")] }],
      subagent: [],
    },
    ready: (screen) => /^● Removing/m.test(screen) && screen.includes("OMCA held this command"),
  },
  {
    name: "doctor",
    cols: 120,
    rows: 46,
    command: "Say hello",
    keys: ["/omca doctor", "Enter"],
    script: { main: [{ content: [text("Hello.")] }], subagent: [] },
    ready: (screen) => screen.includes("checked"),
  },
  {
    name: "statusline",
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
];

function git(cwd: string, home: string, ...args: string[]): void {
  const env = { ...sessionEnv(), HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const { exitCode, stderr } = Bun.spawnSync(["git", "-C", cwd, ...args], { env, stdout: "pipe", stderr: "pipe" });
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr.toString().trim()}`);
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

const plain = (screen: string): string => screen.replace(/\x1b\[[0-9;:]*m/g, "");

export type Capture = { screen: string; forbidden: string[] };

export async function captureShot(shot: Shot): Promise<Capture> {
  const scratch = mkdtempSync(join(tmpdir(), "omca-shots-"));
  const home = join(scratch, "home");
  const project = join(home, "dev", "acme-app");
  const config = join(scratch, "config");
  const mock = startServer({ port: 0, script: shot.script });
  const tmux = new Tmux(SOCKET, ["-f", "/dev/null"]);
  let claudePid: number | undefined;
  try {
    mkdirSync(project, { recursive: true });
    mkdirSync(config);
    writeProject(project, home);
    const plugin = join(scratch, "plugin");
    packageTree(REPO, plugin);
    const bun = Bun.which("bun") ?? "bun";
    const statusline = (entry: string) => `${quote(bun)} ${quote(join(plugin, "statusline", entry))}`;
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify({
        tui: "fullscreen",
        statusLine: { type: "command", command: statusline("main.ts"), padding: 1, refreshInterval: 5, hideVimModeIndicator: true },
        subagentStatusLine: { type: "command", command: statusline("subagent.ts") },
      }),
    );
    tmux.run([
      "new-session", "-d", "-s", tmux.target, "-x", String(shot.cols), "-y", String(shot.rows), "-c", project,
      "-e", `HOME=${home}`,
      "-e", `CLAUDE_CONFIG_DIR=${config}`,
      ...mockSessionEnv(mock.port),
      "-e", "COLORTERM=truecolor",
      "-e", "CLAUDE_STATUSLINE_NERD_FONT=0",
      "-e", "OMCA_DISABLED_HOOKS=stop-gates",
      `claude --plugin-dir ${quote(plugin)} --session-id ${SESSION_ID}`,
    ]);
    claudePid = Number(tmux.run(["display-message", "-p", "-t", tmux.target, "#{pane_pid}"]).trim());
    await reachPrompt(tmux);
    tmux.send("-l", shot.command);
    let screen = await tmux.waitFor((current) => current.includes(shot.command.slice(0, 20)), READY_TIMEOUT_MS, "the command to be typed");
    tmux.send("Enter");
    screen = await tmux.settle(screen);
    for (const key of shot.keys) {
      tmux.send(key);
      screen = await tmux.settle(screen);
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const styled = tmux.styledScreen();
      if (plain(styled).includes("did not load")) throw new Error(`${shot.name}: the plugin snapshot did not load; the screen was:\n${plain(styled)}`);
      if (shot.ready(plain(styled))) return { screen: styled, forbidden: [scratch, tmpdir(), homedir(), userInfo().username] };
      if (Date.now() > deadline) throw new Error(`${shot.name}: never reached its state; the screen was:\n${plain(styled)}`);
      await Bun.sleep(POLL_MS);
    }
  } finally {
    Bun.spawnSync(["tmux", "-L", SOCKET, "-f", "/dev/null", "kill-server"], { env: sessionEnv() });
    if (claudePid !== undefined) await exited(claudePid);
    await mock.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function normalize(capture: Capture, cols: number): string {
  return formatAnsi(maskRows(parseAnsi(capture.screen).map((row) => padRow(row, cols)), capture.forbidden));
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string", default: SOURCE_DIR } },
  });
  const chosen = positionals.length === 0 ? SHOTS : SHOTS.filter((shot) => positionals.includes(shot.name));
  const unknown = positionals.filter((name) => !SHOTS.some((shot) => shot.name === name));
  if (unknown.length > 0 || chosen.length === 0) {
    console.error(`usage: bun scripts/docs/screenshots.ts [<name>...] [--out <dir>]\nnames: ${SHOTS.map((shot) => shot.name).join(" ")}`);
    process.exit(2);
  }
  mkdirSync(values.out, { recursive: true });
  for (const shot of chosen) {
    const out = join(values.out, `${shot.name}.ans`);
    writeFileSync(out, normalize(await captureShot(shot), shot.cols));
    console.log(out);
  }
}
