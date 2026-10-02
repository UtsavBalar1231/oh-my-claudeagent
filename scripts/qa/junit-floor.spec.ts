import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTally, verdict } from "./junit-floor.ts";

const report = (tests: number, failures: number, skipped: number) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${tests}" assertions="9" failures="${failures}" skipped="${skipped}" time="1.5">\n  <testsuite name="a.spec.ts" tests="${tests}" failures="${failures}" skipped="${skipped}">\n  </testsuite>\n</testsuites>\n`;

describe("parseTally", () => {
  test("reads the root counts and derives the passes", () => {
    expect(parseTally(report(100, 2, 5))).toEqual({ tests: 100, failures: 2, skipped: 5, passed: 93 });
  });

  test("ignores the counts of a nested suite", () => {
    expect(parseTally(report(10, 0, 0).replace('<testsuite name="a.spec.ts" tests="10"', '<testsuite name="a.spec.ts" tests="99"')).tests).toBe(10);
  });

  test("throws when there is no testsuites element or a count is missing", () => {
    expect(() => parseTally("")).toThrow("no <testsuites> element");
    expect(() => parseTally('<testsuites tests="3" failures="0">')).toThrow("no <testsuites> element");
  });
});

describe("verdict", () => {
  test("passes at the floor and above it", () => {
    expect(verdict(parseTally(report(100, 0, 10)), 90)).toBeUndefined();
    expect(verdict(parseTally(report(100, 0, 0)), 90)).toBeUndefined();
  });

  test("fails below the floor, counting skips as not passed", () => {
    expect(verdict(parseTally(report(100, 0, 11)), 90)).toBe("89 tests passed, below the floor of 90");
  });

  test("fails on any failure even above the floor", () => {
    expect(verdict(parseTally(report(200, 1, 0)), 90)).toBe("1 tests failed");
  });
});

describe("the script", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omca-junit-floor-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...args: string[]) => {
    const { exitCode, stdout, stderr } = Bun.spawnSync([process.execPath, join(import.meta.dir, "junit-floor.ts"), ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env } });
    return { code: exitCode, out: stdout.toString() + stderr.toString() };
  };

  test("exits 0 and prints the tally when the floor is met", () => {
    const path = join(dir, "r.xml");
    writeFileSync(path, report(50, 0, 3));
    const result = run(path, "47");
    expect(result.code).toBe(0);
    expect(result.out).toContain("50 tests, 47 passed, 0 failed, 3 skipped, floor 47");
  });

  test("exits 1 when the floor is missed", () => {
    const path = join(dir, "r.xml");
    writeFileSync(path, report(50, 0, 3));
    expect(run(path, "48").code).toBe(1);
  });

  test("exits 1 when the report is missing, as after a crash", () => {
    const result = run(join(dir, "none.xml"), "1");
    expect(result.code).toBe(1);
    expect(result.out).toContain("did not finish");
  });

  test("exits 2 for a report it cannot read and for a bad floor", () => {
    const path = join(dir, "r.xml");
    writeFileSync(path, "<truncated");
    expect(run(path, "1").code).toBe(2);
    expect(run(path, "many").code).toBe(2);
    expect(run().code).toBe(2);
  });
});
