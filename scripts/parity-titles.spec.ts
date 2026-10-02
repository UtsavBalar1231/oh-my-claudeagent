import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "parity-titles.ts");

const BATS = [
  "#!/usr/bin/env bats",
  "",
  '@test "alpha: first case" {',
  "  run true",
  "}",
  "",
  '@test "beta: second case" {',
  "  run true",
  "}",
  "",
  '@test "gamma: says \\"hi\\" twice" {',
  "  run true",
  "}",
  "",
].join("\n");

const TS_ALL = [
  'import { test, it } from "bun:test";',
  'test("alpha: first case", () => {});',
  "it('beta: second case', () => {});",
  'test("gamma: says \\"hi\\" twice", () => {});',
  "",
].join("\n");

const TS_WITHOUT_BETA = TS_ALL.replace("it('beta: second case', () => {});\n", "");

let dir: string;

const write = (name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

const run = (args: string[], cwd = dir) => {
  const proc = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd });
  return { code: proc.exitCode, stdout: proc.stdout.toString() };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parity-titles-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parity-titles", () => {
  test("exits 0 and prints nothing when every bats title is ported", () => {
    expect(run([write("a.bats", BATS), write("a.spec.ts", TS_ALL)])).toEqual({ code: 0, stdout: "" });
  });

  test("exits 1 and prints exactly the missing title", () => {
    expect(run([write("a.bats", BATS), write("a.spec.ts", TS_WITHOUT_BETA)])).toEqual({
      code: 1,
      stdout: "beta: second case\n",
    });
  });

  test("a title listed after --replaced is not reported", () => {
    expect(
      run([write("a.bats", BATS), write("a.spec.ts", TS_WITHOUT_BETA), "--replaced", "beta: second case"]),
    ).toEqual({ code: 0, stdout: "" });
  });

  test("--replaced only suppresses the titles it lists", () => {
    const ts = write("a.spec.ts", 'test("gamma: says \\"hi\\" twice", () => {});\n');
    expect(run([write("a.bats", BATS), ts, "--replaced", "alpha: first case"])).toEqual({
      code: 1,
      stdout: "beta: second case\n",
    });
  });

  test("an escaped-quote bats title is matched by the same title in TS", () => {
    const ts = write("a.spec.ts", 'test("gamma: says \\"hi\\" twice", () => {});\n');
    const bats = write("a.bats", BATS);
    expect(run([bats, ts]).stdout).toBe("alpha: first case\nbeta: second case\n");
  });

  test("a title that differs by more than surrounding whitespace counts as missing", () => {
    const bats = write("a.bats", '@test "alpha: first case" {\n}\n');
    expect(run([bats, write("a.spec.ts", 'test("Alpha: first case", () => {});\n')]).stdout).toBe(
      "alpha: first case\n",
    );
    expect(run([bats, write("b.spec.ts", 'test("  alpha: first case  ", () => {});\n')]).code).toBe(0);
  });

  test("reads the bats source through git when given rev:path", () => {
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });
    git("init", "-q");
    write("a.bats", BATS);
    git("add", "a.bats");
    git("commit", "-q", "-m", "bats");
    rmSync(join(dir, "a.bats"));
    const ts = write("a.spec.ts", TS_WITHOUT_BETA);

    expect(run(["HEAD:a.bats", ts])).toEqual({ code: 1, stdout: "beta: second case\n" });
  });

  test("exits 2 when the bats source cannot be read", () => {
    expect(run([join(dir, "missing.bats"), write("a.spec.ts", TS_ALL)]).code).toBe(2);
  });

  test("exits 2 when the TypeScript test file cannot be read", () => {
    expect(run([write("a.bats", BATS), join(dir, "missing.spec.ts")]).code).toBe(2);
  });

  test("exits 2 when an argument is missing", () => {
    expect(run([write("a.bats", BATS)]).code).toBe(2);
  });
});
