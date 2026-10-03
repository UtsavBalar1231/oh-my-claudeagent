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

type Install = { id: string; label: string; updated: string; renderer?: boolean };

// Writes the plugin registry Claude Code keeps, and a renderer that prints its label, for each install.
function installAll(configDir: string, installs: readonly Install[], enabledPlugins: Record<string, boolean> = {}): void {
  const plugins: Record<string, unknown[]> = {};
  for (const { id, label, updated, renderer = true } of installs) {
    const path = join(configDir, "plugins", "cache", id.split("@")[1] ?? "x", "oh-my-claudeagent", label);
    mkdirSync(join(path, "statusline"), { recursive: true });
    if (renderer) {
      for (const entry of ["main", "subagent"]) {
        writeFileSync(join(path, "statusline", `${entry}.ts`), `console.log(${JSON.stringify(`${entry} ${label}`)}, await Bun.stdin.text());\n`);
      }
    }
    plugins[id] = [...(plugins[id] ?? []), { scope: "user", installPath: path, version: label, lastUpdated: updated }];
  }
  mkdirSync(join(configDir, "plugins"), { recursive: true });
  writeFileSync(join(configDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ enabledPlugins }));
}

function run(args: string[], env: Record<string, string>): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync([process.execPath, LAUNCHER, ...args], {
    stdin: new TextEncoder().encode("payload"),
    env: specEnv({ CLAUDE_CONFIG_DIR: undefined, ...env }),
  });
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

const RELEASED = { id: "oh-my-claudeagent@omca", label: "3.0.0", updated: "2026-10-03T10:00:00.000Z" };

test("the recorded install's main renderer runs, and stdin reaches it", () => {
  installAll(join(root, ".claude"), [RELEASED]);
  expect(run([], homeEnv(root))).toEqual({ stdout: "main 3.0.0 payload\n", exitCode: 0 });
});

test("--subagent runs the subagent renderer of that install", () => {
  installAll(join(root, ".claude"), [RELEASED]);
  expect(run(["--subagent"], homeEnv(root))).toEqual({ stdout: "subagent 3.0.0 payload\n", exitCode: 0 });
});

test("any marketplace name and any version string resolve, the most recently updated install first", () => {
  installAll(join(root, ".claude"), [RELEASED, { id: "oh-my-claudeagent@omca-local", label: "3.0.0-dev.d67e9b6", updated: "2026-10-03T18:00:00.000Z" }]);
  expect(run([], homeEnv(root)).stdout).toBe("main 3.0.0-dev.d67e9b6 payload\n");
});

test("an install switched off in settings is passed over for an enabled one", () => {
  installAll(
    join(root, ".claude"),
    [RELEASED, { id: "oh-my-claudeagent@omca-local", label: "3.0.0-dev.d67e9b6", updated: "2026-10-03T18:00:00.000Z" }],
    { "oh-my-claudeagent@omca-local": false },
  );
  expect(run([], homeEnv(root)).stdout).toBe("main 3.0.0 payload\n");
});

test("an install without the renderer, such as a 2.x one, is passed over", () => {
  installAll(join(root, ".claude"), [RELEASED, { id: "oh-my-claudeagent@omca-old", label: "2.21.0", updated: "2026-10-04T00:00:00.000Z", renderer: false }]);
  expect(run([], homeEnv(root)).stdout).toBe("main 3.0.0 payload\n");
});

test("another plugin's install is never chosen", () => {
  installAll(join(root, ".claude"), [{ id: "oh-my-claudeagent-extra@omca", label: "9.9.9", updated: "2026-10-05T00:00:00.000Z" }]);
  expect(run([], homeEnv(root))).toEqual({ stdout: "omca: no installed plugin version found\n", exitCode: 0 });
});

test("CLAUDE_CONFIG_DIR replaces ~/.claude", () => {
  installAll(join(root, ".claude"), [{ ...RELEASED, label: "2.9.0" }]);
  installAll(join(root, "config"), [{ ...RELEASED, label: "3.1.0" }]);
  expect(run([], { ...homeEnv(root), CLAUDE_CONFIG_DIR: join(root, "config") }).stdout).toBe("main 3.1.0 payload\n");
});

test("a config directory with a space, a hash and a percent sign still reaches the renderer", () => {
  const configDir = join(root, "my config #1 100%");
  installAll(configDir, [{ ...RELEASED, label: "3.1.0" }]);
  expect(run([], { ...homeEnv(root), CLAUDE_CONFIG_DIR: configDir })).toEqual({ stdout: "main 3.1.0 payload\n", exitCode: 0 });
  expect(run(["--subagent"], { ...homeEnv(root), CLAUDE_CONFIG_DIR: configDir })).toEqual({ stdout: "subagent 3.1.0 payload\n", exitCode: 0 });
});

test("an unreadable registry or settings file is treated as empty", () => {
  installAll(join(root, ".claude"), [RELEASED]);
  writeFileSync(join(root, ".claude", "settings.json"), "{ not json");
  expect(run([], homeEnv(root)).stdout).toBe("main 3.0.0 payload\n");
  writeFileSync(join(root, ".claude", "plugins", "installed_plugins.json"), "{ not json");
  expect(run([], homeEnv(root))).toEqual({ stdout: "omca: no installed plugin version found\n", exitCode: 0 });
});

test("with no registry the main line prints a notice and exits cleanly", () => {
  expect(run([], homeEnv(root))).toEqual({ stdout: "omca: no installed plugin version found\n", exitCode: 0 });
});

test("with no registry the subagent rows stay empty", () => {
  expect(run(["--subagent"], homeEnv(root))).toEqual({ stdout: "", exitCode: 0 });
});
