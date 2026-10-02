import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pluginRoot } from "./plugin-root.ts";

const SHIPPED = dirname(import.meta.dir);
const saved = process.env.CLAUDE_PLUGIN_ROOT;
const temps: string[] = [];

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = saved;
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omca-plugin-root-"));
  temps.push(dir);
  return dir;
}

test("an existing CLAUDE_PLUGIN_ROOT directory is the plugin root", () => {
  const dir = temp();
  process.env.CLAUDE_PLUGIN_ROOT = dir;
  expect(pluginRoot()).toBe(dir);
});

test("an unset CLAUDE_PLUGIN_ROOT falls back to the root this file ships in", () => {
  delete process.env.CLAUDE_PLUGIN_ROOT;
  expect(pluginRoot()).toBe(SHIPPED);
});

test.each(["", "/c/work/plugin", "C:\\Users\\x\\plugin", "relative/missing"])("a CLAUDE_PLUGIN_ROOT of %p that is no directory here falls back", (value) => {
  process.env.CLAUDE_PLUGIN_ROOT = value;
  expect(pluginRoot()).toBe(SHIPPED);
});

test("a CLAUDE_PLUGIN_ROOT that names a file falls back", () => {
  const file = join(temp(), "plugin");
  writeFileSync(file, "x");
  process.env.CLAUDE_PLUGIN_ROOT = file;
  expect(pluginRoot()).toBe(SHIPPED);
});
