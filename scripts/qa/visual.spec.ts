import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFixture, parseView, withoutBlink } from "./visual.ts";

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
