import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specEnv, tmpEnv } from "../tests/fixtures/spec-env.ts";

const MAIN = join(import.meta.dir, "main.ts");

let root = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omca-statusline-main-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(stdin: string, env: Record<string, string> = {}): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync([process.execPath, MAIN], {
    stdin: new TextEncoder().encode(stdin),
    env: specEnv({ CLAUDE_STATUSLINE_NERD_FONT: "0", COLUMNS: "300", ...tmpEnv(root), ...env }),
  });
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

describe("fallback", () => {
  test.each([
    ["input that is not JSON", "not json"],
    ["an empty input", ""],
    ["a payload without a model", "{}"],
    ["a payload with an empty model", '{"model": {}}'],
    ["a payload that is null", "null"],
    ["a payload that is a list", "[]"],
  ])("%s prints the placeholder and exits cleanly", (_, stdin) => {
    expect(run(stdin)).toEqual({ stdout: "[claude]\n", exitCode: 0 });
  });
});

describe("git cache", () => {
  const cacheFiles = (): string[] => readdirSync(root).filter((name) => name.startsWith("omca-statusline-git-"));

  test("a git read is reused for five seconds and read again after that", () => {
    const project = join(root, "project");
    mkdirSync(project);
    Bun.spawnSync(["git", "-C", project, "init", "-q", "-b", "main"], { env: process.env });
    const payload = JSON.stringify({ model: { display_name: "m" }, workspace: { project_dir: project } });

    const first = run(payload).stdout;
    writeFileSync(join(project, "new.txt"), "x\n");

    expect(first).not.toContain("?1");
    expect(cacheFiles()).toHaveLength(1);
    expect(run(payload).stdout).toBe(first);

    const aged = new Date(Date.now() - 6000);
    utimesSync(join(root, cacheFiles()[0] ?? ""), aged, aged);
    expect(run(payload).stdout).toContain("?1");
  });

  test("a payload without a project directory renders without touching git", () => {
    const { stdout } = run('{"model": {"display_name": "m"}}');
    expect(stdout.split("\n")).toHaveLength(2);
    expect(stdout).toContain("> m");
    expect(readdirSync(root)).toEqual([]);
  });
});
