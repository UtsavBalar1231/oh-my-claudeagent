import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = /\b(?:from|import)\s*\(?\s*["'](?:node:|bun:|claude-code)/;

function offenders(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"))
    .filter((name) => FORBIDDEN.test(readFileSync(join(dir, name), "utf8")))
    .sort();
}

test("no src/core file imports node:, bun: or claude-code", () => {
  expect(offenders(import.meta.dir)).toEqual([]);
});

test.each([
  ['import { readFileSync } from "node:fs";', true],
  ["import type { On } from 'claude-code';", true],
  ['import { expect } from "claude-code/testing";', true],
  ['export { Database } from "bun:sqlite";', true],
  ['import "node:process";', true],
  ['const fs = await import("node:fs");', true],
  ['import { parsePlan } from "./plan.ts";', false],
  ['const label = "node: 22";', false],
])("forbidden-import pattern on %s is %p", (line, expected) => {
  expect(FORBIDDEN.test(line)).toBe(expected);
});
