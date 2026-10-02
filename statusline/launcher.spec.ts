import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeEnv, specEnv } from "../tests/fixtures/spec-env.ts";

const LAUNCHER = join(import.meta.dir, "launcher.ts");

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omca-launcher-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function install(configDir: string, ...versions: string[]): void {
  for (const version of versions) {
    const dir = join(configDir, "plugins", "cache", "omca", "oh-my-claudeagent", version, "statusline");
    mkdirSync(dir, { recursive: true });
    for (const entry of ["main", "subagent"]) {
      writeFileSync(join(dir, `${entry}.ts`), `console.log(${JSON.stringify(`${entry} ${version}`)}, await Bun.stdin.text());\n`);
    }
  }
}

function run(args: string[], env: Record<string, string>): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync([process.execPath, LAUNCHER, ...args], {
    stdin: new TextEncoder().encode("payload"),
    env: specEnv({ CLAUDE_CONFIG_DIR: undefined, ...env }),
  });
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

test("the highest version wins by numeric components, and stdin reaches the renderer", () => {
  install(join(root, ".claude"), "2.9.0", "2.19.1");
  expect(run([], homeEnv(root))).toEqual({ stdout: "main 2.19.1 payload\n", exitCode: 0 });
});

test("--subagent runs the subagent renderer of that version", () => {
  install(join(root, ".claude"), "2.9.0", "2.19.1");
  expect(run(["--subagent"], homeEnv(root))).toEqual({ stdout: "subagent 2.19.1 payload\n", exitCode: 0 });
});

test("entries that are not versions are ignored", () => {
  install(join(root, ".claude"), "3.0.0-beta", "unknown", "2.10.0", "2.9.10");
  expect(run([], homeEnv(root)).stdout).toBe("main 2.10.0 payload\n");
});

test("CLAUDE_CONFIG_DIR replaces ~/.claude", () => {
  install(join(root, ".claude"), "2.9.0");
  install(join(root, "config"), "3.1.0");
  expect(run([], { ...homeEnv(root), CLAUDE_CONFIG_DIR: join(root, "config") }).stdout).toBe("main 3.1.0 payload\n");
});

test("a config directory with a space, a hash and a percent sign still reaches the renderer", () => {
  const configDir = join(root, "my config #1 100%");
  install(configDir, "3.1.0");
  expect(run([], { ...homeEnv(root), CLAUDE_CONFIG_DIR: configDir })).toEqual({ stdout: "main 3.1.0 payload\n", exitCode: 0 });
  expect(run(["--subagent"], { ...homeEnv(root), CLAUDE_CONFIG_DIR: configDir })).toEqual({ stdout: "subagent 3.1.0 payload\n", exitCode: 0 });
});

test("with no cache directory the main line prints a notice and exits cleanly", () => {
  expect(run([], homeEnv(root))).toEqual({ stdout: "omca: no installed plugin version found\n", exitCode: 0 });
});

test("with no cache directory the subagent rows stay empty", () => {
  expect(run(["--subagent"], homeEnv(root))).toEqual({ stdout: "", exitCode: 0 });
});
