#!/usr/bin/env bun
// Reads the JUnit report `bun test --reporter=junit` wrote and fails unless the run has no
// failures and the report lists every spec file under the roots bun test was given. Bun on Windows
// can crash mid-run and still exit 0 (bun issue 40376); a crash leaves no report or a report that
// stops early, and this check turns either into a failure without a hand-kept test count.
//
// Usage: bun scripts/qa/junit-complete.ts <report.xml> <root>...
// Exit: 0 the run is complete, 1 it failed or stopped early, 2 the arguments or the report are unusable.
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type Tally = { tests: number; failures: number; skipped: number; passed: number };

const MAX_LISTED = 20;
const SPEC_PATTERN = "**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mjs,cjs}";

const attribute = (tag: string, name: string): number | undefined => {
  const value = new RegExp(`\\s${name}="(\\d+)"`).exec(tag)?.[1];
  return value === undefined ? undefined : Number(value);
};

export function parseTally(xml: string): Tally {
  const root = /<testsuites\b[^>]*>/.exec(xml)?.[0];
  const tests = root === undefined ? undefined : attribute(root, "tests");
  const failures = root === undefined ? undefined : attribute(root, "failures");
  const skipped = root === undefined ? undefined : attribute(root, "skipped");
  if (tests === undefined || failures === undefined || skipped === undefined) {
    throw new Error("the report has no <testsuites> element with tests, failures and skipped counts");
  }
  return { tests, failures, skipped, passed: tests - failures - skipped };
}

export const canonical = (path: string): string => resolve(path.replaceAll("\\", "/")).replaceAll("\\", "/");

export function reportedFiles(xml: string): Set<string> {
  const files = new Set<string>();
  let depth = 0;
  for (const [, closing, attributes = "", selfClosing] of xml.matchAll(/<(\/?)testsuite\b([^>]*?)(\/?)>/g)) {
    if (closing) {
      depth--;
      continue;
    }
    const file = /\sfile="([^"]*)"/.exec(attributes)?.[1];
    if (depth === 0 && file !== undefined) files.add(canonical(file));
    if (!selfClosing) depth++;
  }
  return files;
}

export function specFiles(roots: string[]): string[] {
  const files = new Set<string>();
  for (const root of roots) {
    for (const file of new Bun.Glob(SPEC_PATTERN).scanSync({ cwd: root, onlyFiles: true })) {
      if (!file.split(/[\\/]/).includes("node_modules")) files.add(canonical(join(root, file)));
    }
  }
  return [...files].sort();
}

if (import.meta.main) {
  const [path, ...roots] = process.argv.slice(2);
  if (path === undefined || roots.length === 0) {
    console.error("Usage: bun scripts/qa/junit-complete.ts <report.xml> <root>...");
    process.exit(2);
  }
  const absent = roots.find((root) => !existsSync(root));
  if (absent !== undefined) {
    console.error(`junit-complete: no such root ${absent}`);
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`junit-complete: no report at ${path}; bun test wrote none, so the run did not finish`);
    process.exit(1);
  }
  let tally: Tally;
  let listed: Set<string>;
  try {
    const xml = readFileSync(path, "utf8");
    tally = parseTally(xml);
    listed = reportedFiles(xml);
  } catch (error) {
    console.error(`junit-complete: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const found = specFiles(roots);
  if (found.length === 0) {
    console.error(`junit-complete: no spec files under ${roots.join(", ")}`);
    process.exit(2);
  }
  const missing = found.filter((file) => !listed.has(file));
  const problems: string[] = [];
  if (tally.failures > 0) problems.push(`junit-complete: ${tally.failures} tests failed`);
  if (missing.length > 0) {
    const shown = missing.slice(0, MAX_LISTED).map((file) => `  ${relative(process.cwd(), file).replaceAll("\\", "/")}`);
    if (missing.length > MAX_LISTED) shown.push(`  and ${missing.length - MAX_LISTED} more`);
    problems.push(`junit-complete: ${missing.length} of ${found.length} spec files are missing from the report, so the run stopped early:\n${shown.join("\n")}`);
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`junit-complete: ${listed.size} of ${found.length} spec files listed, ${tally.tests} tests, ${tally.passed} passed, ${tally.skipped} skipped`);
}
