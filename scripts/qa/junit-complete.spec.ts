import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonical, parseTally, reportedFiles, specFiles } from "./junit-complete.ts";

const suite = (file: string, tests = 1, skipped = 0) =>
  `  <testsuite name="${file}" file="${file}" tests="${tests}" failures="0" skipped="${skipped}">\n    <testsuite name="inner" file="${file}" line="3" tests="${tests}">\n    </testsuite>\n  </testsuite>\n`;

const report = (files: string[], { tests = files.length, failures = 0, skipped = 0 } = {}) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${tests}" assertions="9" failures="${failures}" skipped="${skipped}" time="1.5">\n${files.map((file) => suite(file)).join("")}</testsuites>\n`;

describe("parseTally", () => {
  test("reads the root counts and derives the passes", () => {
    expect(parseTally(report(["a.spec.ts"], { tests: 100, failures: 2, skipped: 5 }))).toEqual({ tests: 100, failures: 2, skipped: 5, passed: 93 });
  });

  test("ignores the counts of a nested suite", () => {
    expect(parseTally(report(["a.spec.ts"], { tests: 10 }).replace('file="a.spec.ts" tests="1"', 'file="a.spec.ts" tests="99"')).tests).toBe(10);
  });

  test("throws when there is no testsuites element or a count is missing", () => {
    expect(() => parseTally("")).toThrow("no <testsuites> element");
    expect(() => parseTally('<testsuites tests="3" failures="0">')).toThrow("no <testsuites> element");
  });
});

describe("reportedFiles", () => {
  test("collects each top-level suite's file once, however many describes repeat it", () => {
    expect([...reportedFiles(report(["a/x.spec.ts", "b/y.spec.ts"]))].sort()).toEqual([canonical("a/x.spec.ts"), canonical("b/y.spec.ts")]);
  });

  test("reads a self-closing top-level suite and skips a nested file the top level lacks", () => {
    const xml = '<testsuites tests="1" failures="0" skipped="0">\n<testsuite name="a" file="a.spec.ts" tests="1"/>\n<testsuite name="b" tests="1">\n<testsuite name="c" file="c.spec.ts"></testsuite>\n</testsuite>\n</testsuites>';
    expect([...reportedFiles(xml)]).toEqual([canonical("a.spec.ts")]);
  });

  test("treats a backslash path as the same file as its slash form", () => {
    expect(reportedFiles(report(["scripts\\qa\\x.spec.ts"]))).toEqual(new Set([canonical("scripts/qa/x.spec.ts")]));
  });
});

describe("the script", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omca-junit-complete-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const touch = (...paths: string[]) => {
    for (const path of paths) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), "");
    }
  };
  const writeReport = (xml: string) => writeFileSync(join(dir, "r.xml"), xml);
  const run = (...args: string[]) => {
    const { exitCode, stdout, stderr } = Bun.spawnSync([process.execPath, join(import.meta.dir, "junit-complete.ts"), ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env } });
    return { code: exitCode, out: stdout.toString(), err: stderr.toString() };
  };

  test("exits 0 and prints the tally when the report lists every spec file", () => {
    touch("src/a.spec.ts", "src/deep/b.test.ts", "lib/c_spec.js");
    writeReport(report(["src/a.spec.ts", "src/deep/b.test.ts", "lib/c_spec.js"], { tests: 6, skipped: 1 }));
    expect(run("r.xml", "src", "lib")).toEqual({ code: 0, out: "junit-complete: 3 of 3 spec files listed, 6 tests, 5 passed, 1 skipped\n", err: "" });
  });

  test("exits 1 and names the file a stopped run left out", () => {
    touch("src/a.spec.ts", "src/b.spec.ts");
    writeReport(report(["src/a.spec.ts"]));
    expect(run("r.xml", "src")).toEqual({ code: 1, out: "", err: "junit-complete: 1 of 2 spec files are missing from the report, so the run stopped early:\n  src/b.spec.ts\n" });
  });

  test("lists the first 20 missing files and counts the rest", () => {
    const files = Array.from({ length: 23 }, (_, index) => `src/s${String(index).padStart(2, "0")}.spec.ts`);
    touch(...files);
    writeReport(report([]));
    const result = run("r.xml", "src");
    expect(result.code).toBe(1);
    expect(result.err).toBe(`junit-complete: 23 of 23 spec files are missing from the report, so the run stopped early:\n${files.slice(0, 20).map((file) => `  ${file}`).join("\n")}\n  and 3 more\n`);
  });

  test("exits 1 on a failure even when every file is listed", () => {
    touch("src/a.spec.ts");
    writeReport(report(["src/a.spec.ts"], { tests: 4, failures: 2 }));
    expect(run("r.xml", "src")).toEqual({ code: 1, out: "", err: "junit-complete: 2 tests failed\n" });
  });

  test("exits 1 when the report is missing, as after a crash", () => {
    touch("src/a.spec.ts");
    expect(run("none.xml", "src")).toEqual({ code: 1, out: "", err: "junit-complete: no report at none.xml; bun test wrote none, so the run did not finish\n" });
  });

  test("exits 2 for a report it cannot parse", () => {
    touch("src/a.spec.ts");
    writeReport("<truncated");
    expect(run("r.xml", "src")).toEqual({ code: 2, out: "", err: "junit-complete: r.xml: the report has no <testsuites> element with tests, failures and skipped counts\n" });
  });

  test("exits 2 for missing arguments and for a root that does not exist", () => {
    expect(run()).toEqual({ code: 2, out: "", err: "Usage: bun scripts/qa/junit-complete.ts <report.xml> <root>...\n" });
    expect(run("r.xml")).toEqual({ code: 2, out: "", err: "Usage: bun scripts/qa/junit-complete.ts <report.xml> <root>...\n" });
    expect(run("r.xml", "nowhere")).toEqual({ code: 2, out: "", err: "junit-complete: no such root nowhere\n" });
  });

  test("exits 2 when the roots hold no spec file, since there is nothing to check", () => {
    touch("src/a.ts", "lib/readme.md");
    writeReport(report([]));
    expect(run("r.xml", "src", "lib")).toEqual({ code: 2, out: "", err: "junit-complete: no spec files under src, lib\n" });
  });

  test("counts a file whose tests are all skipped as present", () => {
    touch("src/a.spec.ts", "src/skipped.spec.ts");
    writeReport(
      `<testsuites name="bun test" tests="2" failures="0" skipped="1">\n${suite("src/a.spec.ts")}${suite("src/skipped.spec.ts", 1, 1)}</testsuites>\n`,
    );
    expect(run("r.xml", "src")).toEqual({ code: 0, out: "junit-complete: 2 of 2 spec files listed, 2 tests, 1 passed, 1 skipped\n", err: "" });
  });

  test("matches a report that writes backslash paths on a POSIX checkout", () => {
    touch("src/deep/a.spec.ts");
    writeReport(report(["src\\deep\\a.spec.ts"]));
    expect(run("r.xml", "src")).toEqual({ code: 0, out: "junit-complete: 1 of 1 spec files listed, 1 tests, 1 passed, 0 skipped\n", err: "" });
  });
});

describe("specFiles", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omca-junit-complete-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const touch = (path: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), "");
  };

  test("finds the names bun test runs and skips node_modules and other names", () => {
    const wanted = ["a.test.ts", "b_test.js", "c.spec.tsx", "d_spec.mjs", "e.spec.cjs", "f.test.jsx", "deep/er/g.spec.ts"];
    const ignored = ["h.ts", "i.specs.ts", "j.spec.json", "node_modules/k.spec.ts", "deep/node_modules/l.test.ts", "specs.ts"];
    for (const path of [...wanted, ...ignored]) touch(`root/${path}`);
    expect(specFiles([join(dir, "root")])).toEqual(wanted.map((path) => canonical(join(dir, "root", path))).sort());
  });

  test("lists a file once when two roots overlap", () => {
    touch("root/sub/a.spec.ts");
    expect(specFiles([join(dir, "root"), join(dir, "root", "sub")])).toEqual([canonical(join(dir, "root", "sub", "a.spec.ts"))]);
  });
});
