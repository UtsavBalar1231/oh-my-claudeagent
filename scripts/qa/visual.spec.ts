import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGitRemote, captureName, copyFixture, INLINE_PLUGIN_KEY, maskLive, maskScratch, mouseReports, parseSizes, parseView, sessionSettings, teardown, withoutBlink } from "./visual.ts";

const VISUAL = join(import.meta.dir, "visual.ts");
const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseView", () => {
  test("reads every field and defaults the optional ones", () => {
    expect(parseView('{"command":"/omca evidence","keys":["n","Escape"],"mockScript":"turn","fixture":"pane"}')).toEqual({
      command: "/omca evidence",
      keys: ["n", "Escape"],
      mockScript: "turn",
      fixture: "pane",
    });
    expect(parseView('{"command":"/omca stats","mockScript":null}')).toEqual({
      command: "/omca stats",
      keys: [],
      mockScript: null,
      fixture: null,
    });
  });

  test("reads env, options, settings, gitRemote and startDelayMs when present", () => {
    expect(
      parseView(
        '{"command":"x","env":{"A_B":"1"},"options":{"guardMode":"deny"},"settings":{"permissions":{"allow":["Bash"]}},"gitRemote":true,"startDelayMs":4000}',
      ),
    ).toEqual({
      command: "x",
      keys: [],
      mockScript: null,
      fixture: null,
      env: { A_B: "1" },
      options: { guardMode: "deny" },
      settings: { permissions: { allow: ["Bash"] } },
      gitRemote: true,
      startDelayMs: 4000,
    });
    expect(Object.keys(parseView('{"command":"x","gitRemote":false,"startDelayMs":0}'))).not.toContain("gitRemote");
  });

  test.each([
    ["[]", "a view must be a JSON object"],
    ['{"command":"x","env":{"A":1}}', '"env" must be an object of string values named like variables'],
    ['{"command":"x","env":{"A B":"1"}}', '"env" must be an object of string values named like variables'],
    ['{"command":"x","env":[]}', '"env" must be an object of string values named like variables'],
    ['{"command":"x","options":[]}', '"options" must be an object'],
    ['{"command":"x","settings":"s"}', '"settings" must be an object'],
    ['{"command":"x","gitRemote":"yes"}', '"gitRemote" must be a boolean'],
    ['{"command":"x","startDelayMs":-1}', '"startDelayMs" must be a non-negative integer'],
    ['{"command":"x","startDelayMs":1.5}', '"startDelayMs" must be a non-negative integer'],
    ['{"command":"x","startDelayMs":"5"}', '"startDelayMs" must be a non-negative integer'],
    ["{}", '"command" must be a non-empty string'],
    ['{"command":""}', '"command" must be a non-empty string'],
    ['{"command":"x","keys":"n"}', '"keys" must be an array of non-empty strings'],
    ['{"command":"x","keys":["n",""]}', '"keys" must be an array of non-empty strings'],
    ['{"command":"x","mockScript":"../escape"}', '"mockScript" must be a file name or null'],
    ['{"command":"x","fixture":"a/b"}', '"fixture" must be a directory name or null'],
  ])("rejects %s", (text, message) => {
    expect(() => parseView(text)).toThrow(message);
  });
});

describe("sessionSettings", () => {
  const base = parseView('{"command":"x"}');

  test("a plain view keeps the fullscreen settings, and --inline drops tui only", () => {
    expect(sessionSettings(base, false)).toEqual({ tui: "fullscreen", prefersReducedMotion: true });
    expect(sessionSettings(base, true)).toEqual({ prefersReducedMotion: true });
  });

  test("options go under the --plugin-dir key and settings merge in", () => {
    expect(INLINE_PLUGIN_KEY).toBe("oh-my-claudeagent@inline");
    const view = parseView('{"command":"x","options":{"guardMode":"deny"},"settings":{"permissions":{"allow":["Bash"]}}}');
    expect(sessionSettings(view, false)).toEqual({
      tui: "fullscreen",
      prefersReducedMotion: true,
      permissions: { allow: ["Bash"] },
      pluginConfigs: { "oh-my-claudeagent@inline": { options: { guardMode: "deny" } } },
    });
  });
});

test("captureName keeps the default names and marks an inline capture", () => {
  expect(captureName("footer", 120, 40, false, false)).toBe("footer-120.txt");
  expect(captureName("footer", 120, 40, true, false)).toBe("footer-120x40.txt");
  expect(captureName("footer", 120, 40, false, true)).toBe("footer-inline-120.txt");
  expect(captureName("footer", 120, 40, true, true)).toBe("footer-inline-120x40.txt");
});

test.skipIf(Bun.which("git") === null)("addGitRemote makes the cwd its own repository with one commit on main pushed to a bare origin", () => {
  const scratch = temp("omca-visual-git-");
  const cwd = join(scratch, "cwd");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "a.txt"), "a\n");
  addGitRemote(cwd, scratch);
  const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe" }).stdout.toString().trim();
  expect(realpathSync(git(cwd, "rev-parse", "--show-toplevel"))).toBe(realpathSync(cwd));
  expect(git(cwd, "rev-list", "--count", "HEAD")).toBe("1");
  expect(git(cwd, "rev-parse", "HEAD")).toBe(git(join(scratch, "remote.git"), "rev-parse", "main"));
  expect(git(cwd, "status", "--porcelain")).toBe("");
});

describe("mouseReports", () => {
  const screen = ["╭─ tabs ─╮", "│ 1: Agents  4: Notepad", "│ ╭ Learnings · 3 entries"].join("\n");

  test("a key is not a mouse step", () => {
    expect(mouseReports("Down", screen)).toBeUndefined();
    expect(mouseReports("4", screen)).toBeUndefined();
  });

  test("a wheel step sends one SGR report per tick at the anchor's first cell, 1-based, moved by the offset", () => {
    expect(mouseReports("wheel-down*2@Learnings", screen)).toEqual(["\x1b[<65;5;3M", "\x1b[<65;5;3M"]);
    expect(mouseReports("wheel-up@Learnings:+3,-1", screen)).toEqual(["\x1b[<64;8;2M"]);
  });

  test("a click is a press and a release in one report", () => {
    expect(mouseReports("click@Notepad", screen)).toEqual(["\x1b[<0;17;2M\x1b[<0;17;2m"]);
  });

  test("an anchor the screen does not show throws, naming the step", () => {
    expect(() => mouseReports("click@Issues", screen)).toThrow('no "Issues" on the screen for the step click@Issues');
  });
});

test("parseSizes reads columns by rows and refuses anything else", () => {
  expect(parseSizes("80x24, 160x30")).toEqual([
    [80, 24],
    [160, 30],
  ]);
  expect(() => parseSizes("80")).toThrow('a size is <columns>x<rows>, not "80"');
});

test("copyFixture copies the tree, points {{cwd}} at the copy, and dates every file an hour back", () => {
  const from = temp("omca-visual-fixture-");
  const to = join(temp("omca-visual-copy-"), "cwd");
  mkdirSync(join(from, ".omca", "state"), { recursive: true });
  writeFileSync(join(from, ".omca", "state", "mod.json"), '{"dir":"{{cwd}}/src","again":"{{cwd}}"}');
  writeFileSync(join(from, "notes.md"), "no token here\n");

  copyFixture(from, to);

  expect(readFileSync(join(to, ".omca", "state", "mod.json"), "utf8")).toBe(`{"dir":"${to}/src","again":"${to}"}`);
  expect(readFileSync(join(to, "notes.md"), "utf8")).toBe("no token here\n");
  expect(readFileSync(join(from, ".omca", "state", "mod.json"), "utf8")).toContain("{{cwd}}");
  for (const path of [join(to, "notes.md"), join(to, ".omca", "state", "mod.json")]) {
    const age = Date.now() - statSync(path).mtimeMs;
    expect(age).toBeGreaterThanOrEqual(3_600_000 - 1_000);
    expect(age).toBeLessThan(3_600_000 + 60_000);
  }
});

test("maskScratch replaces the scratch directory's random suffix wherever the screen shows it", () => {
  const scratch = join(tmpdir(), "omca-visual-120x40-Ab3dE9");
  const screen = `cwd ${scratch}/cwd\n…ual-120x40-Ab3dE9/cwd │ Ab3dE`;

  expect(maskScratch(screen, scratch)).toBe(`cwd ${join(tmpdir(), "omca-visual-120x40-XXXXXX")}/cwd\n…ual-120x40-XXXXXX/cwd │ Ab3dE`);
});

test("maskLive fixes the live session's times, engine cost, running seconds and token counts, leaves a stored figure, and keeps a line's width beside a pane", () => {
  const screen = [
    "✻ Sautéed for 0s · done 1:36 PM          │ pane",
    "r: Run again   ✓ 9 ok  checked 16:42",
    "  13:35  FINAL    ✓  0  just ci",
    "✻ Baked for 2s · done 10:07 PM",
    "✻ Churned for 1m 4s · done 3:35 AM · 38.2k in 13 out · $0.8787 ·  just test not logged  │ pane",
    "✻ Waiting for executor, architect · 26.7k in 48 out · $0.1024",
    "  $12.40 engine cost",
    "│  explorer · Map the router callers   sonnet-5-5  high       3s    │",
    "│   ▄▄▀▀▀▀▀▀▄▄     explorer           running     12s",
    "  ◯ oh-my-claudeagent:explorer   Map the router callers      3s · ↓ 23.2k tokens",
    "│ │  explorer     ██████████     4     24s    172k",
    "│ d: Details  2 running · 1 finished · 128k tokens   sonnet-5-5 · high · 62.2k tokens",
  ].join("\n");

  expect(maskLive(screen).split("\n")).toEqual([
    "✻ Worked for 0s · done HH:MM             │ pane",
    "r: Run again   ✓ 9 ok  checked HH:MM",
    "  13:35  FINAL    ✓  0  just ci",
    "✻ Worked for 2s · done HH:MM",
    "✻ Worked for 1m 4s · done HH:MM · NN.Nk in NN out · $X.XX ·  just test not logged       │ pane",
    "✻ Waiting for executor, architect · NN.Nk in NN out · $X.XX",
    "  $12.40 engine cost",
    "│  explorer · Map the router callers   sonnet-5-5  high       Ns    │",
    "│   ▄▄▀▀▀▀▀▀▄▄     explorer           running     NNs",
    "  ◯ oh-my-claudeagent:explorer   Map the router callers      Ns · ↓ NN.Nk tokens",
    "│ │  explorer     ██████████     4     24s    172k",
    "│ d: Details  2 running · 1 finished · NNNk tokens   sonnet-5-5 · high · NN.Nk tokens",
  ]);
});

test("maskLive fixes an agent page's running seconds, a tool line's timers and the spinner's verb, keeping each line's width", () => {
  const screen = [
    "│      ▄▄▄▄         running · 35s · 60.1k tokens │",
    "  Searching for 2 patterns, running 1 shell command · 35s…",
    "  ⎿  $ sleep 90 (34s)",
    "● Shimmying… (35s · ↓ 15.3k tokens)  │ pane",
    "  Smooshing… (5s · ↓ 1.2k tokens)",
    "│      ▀        ▄  started 02:16",
    "│ Bash ls plans                                 101ms",
    "│ Read src/a.ts                                  66ms",
  ].join("\n");

  expect(maskLive(screen).split("\n")).toEqual([
    "│      ▄▄▄▄         running · NNs · NN.Nk tokens │",
    "  Searching for 2 patterns, running 1 shell command · NNs…",
    "  ⎿  $ sleep 90 (NNs)",
    "● Working… (NNs · ↓ NN.Nk tokens)    │ pane",
    "  Working… (Ns · ↓ N.Nk tokens)",
    "│      ▀        ▄  started HH:MM",
    "│ Bash ls plans                                   Nms",
    "│ Read src/a.ts                                   Nms",
  ]);
});

const SIZES = [
  [80, 40],
  [120, 40],
  [200, 50],
] as const;

test.skipIf(Bun.which("tmux") === null || Bun.which("claude") === null)(
  "a stub view is captured at all three sizes from a real session against the mock (skipped where tmux or claude is not installed)",
  async () => {
    const root = temp("omca-visual-root-");
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "fixtures", "stub"), { recursive: true });
    writeFileSync(join(root, "stub.json"), JSON.stringify({ command: "say the stub line", mockScript: "stub", fixture: "stub" }));
    writeFileSync(
      join(root, "scripts", "stub.json"),
      JSON.stringify({ main: [{ content: [{ type: "text", text: "visual stub ok" }] }] }),
    );
    writeFileSync(join(root, "fixtures", "stub", "README.md"), "fixture\n");

    const run = Bun.spawn([process.execPath, VISUAL, "stub", "--root", root], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout.trim().split("\n")).toEqual(SIZES.map(([cols]) => join(root, `stub-${cols}.txt`)));
    for (const [cols, rows] of SIZES) {
      const lines = readFileSync(join(root, `stub-${cols}.txt`), "utf8").replace(/\n$/, "").split("\n");
      expect(lines.length).toBe(rows);
      expect(Math.max(...lines.map((line) => [...line].length))).toBeLessThanOrEqual(cols);
      expect(lines.some((line) => line.includes("say the stub line"))).toBe(true);
      expect(lines.some((line) => line.includes("● visual stub ok"))).toBe(true);
      expect(existsSync(join(tmpdir(), `omca-visual-${cols}x${rows}`))).toBe(false);
    }
    expect(Bun.spawnSync(["tmux", "-L", `omca-visual-${run.pid}`, "list-sessions"], { env: process.env }).exitCode).not.toBe(0);
  },
  120_000,
);

test("withoutBlink masks only a bullet that leads its line, so both blink phases compare equal", () => {
  const lit = "❯ Clean the build\n\n● Removing the build output\n  ⎿  $ rm -rf build\n│ ● not a pending tool";
  const dark = "❯ Clean the build\n\n  Removing the build output\n  ⎿  $ rm -rf build\n│ ● not a pending tool";

  expect(withoutBlink(lit)).toBe(withoutBlink(dark));
  expect(withoutBlink(lit)).toBe(dark);
  expect(withoutBlink("● Removing the build output")).not.toBe(withoutBlink("● Removed the build output"));
});

describe("teardown", () => {
  test("runs every step in order even when earlier ones throw, then rethrows the first error", async () => {
    const ran: string[] = [];
    const step = (name: string, error?: Error) => async () => {
      await Bun.sleep(1);
      ran.push(name);
      if (error !== undefined) throw error;
    };
    const first = new Error("first");
    await expect(teardown(step("a"), step("b", first), step("c", new Error("second")), step("d"))).rejects.toBe(first);
    expect(ran).toEqual(["a", "b", "c", "d"]);
  });

  test("resolves when no step throws", async () => {
    const ran: string[] = [];
    await teardown(() => void ran.push("a"), async () => void ran.push("b"));
    expect(ran).toEqual(["a", "b"]);
  });
});
