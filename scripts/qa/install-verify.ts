#!/usr/bin/env bun
// Structural checks against a packaged copy of the plugin, the artifact a user installs: the
// manifest validates, every hook module resolves inside the copy, and the packaged omca
// server answers the validator's stdio handshake with the tools the fixture lists. No model session runs.
//
// Usage: bun scripts/qa/install-verify.ts
// Exit: 0 pass, 1 a check failed, 2 the run could not be set up.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serverHandshake } from "../validate/mcp.ts";
import { type Checks, childEnv, claudeBin, REPO, runQa } from "./lib.ts";

export function checkHookModules(checks: Checks, pluginDir: string): void {
  const hooksJson = join(pluginDir, "hooks", "hooks.json");
  if (!existsSync(hooksJson)) {
    checks.fail(`hooks.json missing from packaged tree at ${hooksJson}`);
    return;
  }
  const { modules = [] } = JSON.parse(readFileSync(hooksJson, "utf8")) as { modules?: string[] };
  const missing = modules.filter((module) => !existsSync(join(pluginDir, "hooks", module)));
  for (const module of missing) checks.fail(`hook module does not resolve in package: ${module}`);
  if (modules.length === 0) checks.fail(`no hook modules named in ${hooksJson}`);
  else if (missing.length === 0) checks.pass(`all ${modules.length} hook modules resolve inside the packaged tree`);
}

export async function checkPluginValidate(checks: Checks, pluginDir: string, configDir: string): Promise<void> {
  const manifest = join(pluginDir, ".claude-plugin", "plugin.json");
  const proc = Bun.spawn([claudeBin(), "plugin", "validate", manifest], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv({ CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: "1" }),
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  checks.check(code === 0, `claude plugin validate: ${manifest}`, `claude plugin validate exited ${code}: ${(stdout + stderr).trim()}`);
}

function checkMcpHandshake(checks: Checks, pluginDir: string): void {
  const { status, detail } = serverHandshake(REPO, join(pluginDir, "servers", "omca.ts"));
  checks.check(status === "pass", `packaged mcp server: ${detail}`, `packaged mcp server: ${detail}`);
}

if (import.meta.main) {
  await runQa(
    "install-verify",
    async ({ checks, scratch }) => {
      const pluginDir = scratch.plugin();
      await checkPluginValidate(checks, pluginDir, scratch.dir("config"));
      checkHookModules(checks, pluginDir);
      checkMcpHandshake(checks, pluginDir);
    },
    { watchRealConfig: true },
  );
}
