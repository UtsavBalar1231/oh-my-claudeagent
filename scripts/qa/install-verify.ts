#!/usr/bin/env bun
// Structural checks against a packaged copy of the plugin, the artifact a user installs: the
// manifest validates, every hook module resolves inside the copy, and the packaged omca
// server answers a stdio handshake with the tools the fixture lists. No model session runs.
//
// Usage: bun scripts/qa/install-verify.ts
// Exit: 0 pass, 1 a check failed, 2 the run could not be set up.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Checks, childEnv, REPO, runQa } from "./lib.ts";

const FIXTURES = join(REPO, "tests", "fixtures", "mcp");
const HANDSHAKE_TIMEOUT_MS = 45_000;
const STDERR_EXCERPT_LINES = 8;

type RpcResponse = { id: number; result?: { tools?: { name: string }[] } };

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8").trim();

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

async function checkPluginValidate(checks: Checks, pluginDir: string, configDir: string): Promise<void> {
  const proc = Bun.spawn([Bun.which(process.env.QA_CLAUDE_BIN ?? "claude") ?? "claude", "plugin", "validate", pluginDir], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv({ CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: "1" }),
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  checks.check(code === 0, `claude plugin validate: ${pluginDir}`, `claude plugin validate exited ${code}: ${(stdout + stderr).trim()}`);
}

async function handshake(argv: string[], cwd: string, requests: string[]): Promise<{ responses: Map<number, RpcResponse>; stderr: string }> {
  const wanted = requests.flatMap((line) => {
    const { id } = JSON.parse(line) as { id?: number };
    return id === undefined ? [] : [id];
  });
  const proc = Bun.spawn(argv, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: childEnv() });
  const timer = setTimeout(() => proc.kill(), HANDSHAKE_TIMEOUT_MS);
  const responses = new Map<number, RpcResponse>();
  try {
    proc.stdin.write(`${requests.join("\n")}\n`);
    await proc.stdin.flush();
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter((l) => l.trim() !== "")) {
        const message = JSON.parse(line) as RpcResponse;
        if (typeof message.id === "number") responses.set(message.id, message);
      }
      if (wanted.every((id) => responses.has(id))) break;
    }
  } finally {
    clearTimeout(timer);
    proc.kill();
    await proc.exited;
  }
  const stderr = (await new Response(proc.stderr).text()).split("\n").slice(0, STDERR_EXCERPT_LINES).join("\n");
  return { responses, stderr };
}

async function checkMcpHandshake(checks: Checks, pluginDir: string, cwd: string): Promise<void> {
  const server = join(pluginDir, "servers", "omca.ts");
  if (!existsSync(server)) {
    checks.fail(`packaged server missing at ${server}`);
    return;
  }
  const { responses, stderr } = await handshake(["bun", server], cwd, [
    fixture("initialize.json"),
    fixture("initialized-notification.json"),
    fixture("tools-list.json"),
  ]);
  const initialize = responses.get(1);
  const list = responses.get(2);
  checks.check(initialize?.result !== undefined, "packaged mcp server: initialize response received", `packaged mcp server: initialize response missing${stderr ? `: ${stderr}` : ""}`);
  checks.check(list?.result?.tools !== undefined, "packaged mcp server: tools/list response received", `packaged mcp server: tools/list response missing${stderr ? `: ${stderr}` : ""}`);
  const listed = new Set((list?.result?.tools ?? []).map((tool) => tool.name));
  const expected = JSON.parse(fixture("expected-tools.json")) as string[];
  const missing = expected.filter((name) => !listed.has(name));
  checks.check(missing.length === 0, `packaged mcp server lists all ${expected.length} expected tools`, `packaged mcp server tools/list is missing: ${missing.join(", ")}`);
}

function checkTemplate(checks: Checks, pluginDir: string): void {
  const present = existsSync(join(pluginDir, "templates", "claudemd.md"));
  checks.check(present, "templates/claudemd.md present in packaged tree", "templates/claudemd.md missing from packaged tree");
}

if (import.meta.main) {
  await runQa(
    "install-verify",
    async ({ checks, scratch }) => {
      const pluginDir = scratch.plugin();
      await checkPluginValidate(checks, pluginDir, scratch.dir("config"));
      checkHookModules(checks, pluginDir);
      await checkMcpHandshake(checks, pluginDir, scratch.project());
      checkTemplate(checks, pluginDir);
    },
    { watchRealConfig: true },
  );
}
