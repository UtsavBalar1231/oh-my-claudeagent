#!/usr/bin/env bun
// Reads the JUnit report `bun test --reporter=junit` wrote and fails unless the run has no
// failures and at least <floor> tests passed. Bun on Windows can crash mid-run and still exit 0
// (bun issue 40376); a crash leaves no report or a short one, and this check turns either into a
// failure.
//
// Usage: bun scripts/qa/junit-floor.ts <report.xml> <floor>
// Exit: 0 the floor is met, 1 it is not, 2 the arguments or the report are unusable.
import { existsSync, readFileSync } from "node:fs";

export type Tally = { tests: number; failures: number; skipped: number; passed: number };

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

export function verdict(tally: Tally, floor: number): string | undefined {
  if (tally.failures > 0) return `${tally.failures} tests failed`;
  if (tally.passed < floor) return `${tally.passed} tests passed, below the floor of ${floor}`;
  return undefined;
}

if (import.meta.main) {
  const [path, rawFloor] = process.argv.slice(2);
  const floor = Number(rawFloor);
  if (path === undefined || !Number.isInteger(floor) || floor < 1) {
    console.error("Usage: bun scripts/qa/junit-floor.ts <report.xml> <floor>");
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`junit-floor: no report at ${path}; bun test wrote none, so the run did not finish`);
    process.exit(1);
  }
  let tally: Tally;
  try {
    tally = parseTally(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`junit-floor: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const problem = verdict(tally, floor);
  console.log(`junit-floor: ${tally.tests} tests, ${tally.passed} passed, ${tally.failures} failed, ${tally.skipped} skipped, floor ${floor}`);
  if (problem !== undefined) {
    console.error(`junit-floor: ${problem}`);
    process.exit(1);
  }
}
