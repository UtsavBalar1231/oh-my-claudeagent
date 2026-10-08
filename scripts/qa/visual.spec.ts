import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFixture, maskClock, maskScratch, mouseReports, parseSizes, parseView, teardown, withoutBlink } from "./visual.ts";

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
    expect(parseView('{"command":"/omca plan","keys":["n","Escape"],"mockScript":"turn","fixture":"pane"}')).toEqual({
      command: "/omca plan",
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

  test.each([
    ["[]", "a view must be a JSON object"],
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

test("copyFixture copies the tree and points {{cwd}} at the copy", () => {
  const from = temp("omca-visual-fixture-");
  const to = join(temp("omca-visual-copy-"), "cwd");
  mkdirSync(join(from, ".omca", "state"), { recursive: true });
  writeFileSync(join(from, ".omca", "state", "boulder.json"), '{"active_plan":"{{cwd}}/plans/p.md","again":"{{cwd}}"}');
  writeFileSync(join(from, "notes.md"), "no token here\n");

  copyFixture(from, to);

  expect(readFileSync(join(to, ".omca", "state", "boulder.json"), "utf8")).toBe(
    `{"active_plan":"${to}/plans/p.md","again":"${to}"}`,
  );
  expect(readFileSync(join(to, "notes.md"), "utf8")).toBe("no token here\n");
  expect(readFileSync(join(from, ".omca", "state", "boulder.json"), "utf8")).toContain("{{cwd}}");
});

test("copyFixture takes a plan boulder.json names from the shared plans when the fixture lacks it, and keeps the fixture's own", () => {
  const from = temp("omca-visual-fixture-");
  const shared = temp("omca-visual-shared-");
  const to = join(temp("omca-visual-copy-"), "cwd");
  mkdirSync(join(from, ".omca", "state"), { recursive: true });
  mkdirSync(join(from, "plans"));
  writeFileSync(join(from, ".omca", "state", "boulder.json"), '{"a":"{{cwd}}/plans/shared.md","b":"{{cwd}}/plans/own.md","c":"{{cwd}}/plans/nowhere.md"}');
  writeFileSync(join(from, "plans", "own.md"), "fixture's own\n");
  writeFileSync(join(shared, "shared.md"), "shared plan\n");
  writeFileSync(join(shared, "own.md"), "shared copy\n");

  copyFixture(from, to, shared);

  expect(readdirSync(join(to, "plans")).sort()).toEqual(["own.md", "shared.md"]);
  expect(readFileSync(join(to, "plans", "shared.md"), "utf8")).toBe("shared plan\n");
  expect(readFileSync(join(to, "plans", "own.md"), "utf8")).toBe("fixture's own\n");
});

test("the band and pane fixtures get the 46-task plan from tests/fixtures/plans", () => {
  const plan = readFileSync(join(import.meta.dir, "..", "..", "tests", "fixtures", "plans", "46-task-plan.md"), "utf8");
  for (const fixture of ["band", "pane"]) {
    const to = join(temp(`omca-visual-${fixture}-`), "cwd");
    copyFixture(join(import.meta.dir, "..", "..", "tests", "mod", "visual", "fixtures", fixture), to);
    expect(readFileSync(join(to, "plans", "46-task-plan.md"), "utf8")).toBe(plan);
  }
});

test("maskScratch replaces the scratch directory's random suffix wherever the screen shows it", () => {
  const scratch = join(tmpdir(), "omca-visual-120x40-Ab3dE9");
  const screen = `cwd ${scratch}/cwd\n…ual-120x40-Ab3dE9/cwd │ Ab3dE`;

  expect(maskScratch(screen, scratch)).toBe(`cwd ${join(tmpdir(), "omca-visual-120x40-XXXXXX")}/cwd\n…ual-120x40-XXXXXX/cwd │ Ab3dE`);
});

test("maskClock fixes the live session's times and keeps a line's width beside a pane", () => {
  const screen = [
    "✻ Sautéed for 0s · done 1:36 PM          │ pane",
    "r: Run again   ✓ 9 ok  checked 16:42",
    "  ↑ UP    10-03 13:36  good",
    "  13:35  FINAL    ✓  0  just ci",
    "✻ Baked for 2s · done 10:07 PM",
  ].join("\n");

  expect(maskClock(screen).split("\n")).toEqual([
    "✻ Worked for 0s · done HH:MM             │ pane",
    "r: Run again   ✓ 9 ok  checked HH:MM",
    "  ↑ UP    MM-DD HH:MM  good",
    "  13:35  FINAL    ✓  0  just ci",
    "✻ Worked for 2s · done HH:MM",
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
