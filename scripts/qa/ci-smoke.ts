#!/usr/bin/env bun
// The CI smoke, run on every OS the workflow covers: one headless `claude -p` session with the
// packaged plugin loaded, a scratch project, its own CLAUDE_CONFIG_DIR and a dummy token against
// the mock model. The scripted turns issue a recursive removal the mod's tool.check guard must
// deny, and the checks read the client's `--debug-file` for the omca_hook calls and the deny.
//
// On Windows the script first issues the same refusal through the PowerShell tool. Whether the
// session offers that tool is read from the stream-json init message; when it does not, the run
// says so and checks the Bash deny alone.
//
// Usage: bun scripts/qa/ci-smoke.ts
// Exit: 0 pass, 1 a check failed, 2 the run could not be set up.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AccessEntry,
  CANARY,
  call,
  guardDenies,
  hookCalls,
  localhostOnly,
  parseJsonLines,
  pluginDenies,
  type Qa,
  readJsonLines,
  runClaude,
  runQa,
  say,
  startMock,
  type TraceEntry,
} from "./lib.ts";
import type { Script } from "./mock-model.ts";

const POWERSHELL_TARGET = "C:\\omca-ci-smoke-no-such-dir";

type Init = { type?: string; subtype?: string; tools?: unknown };

export function offeredTools(streamJson: string): string[] {
  const init = parseJsonLines<Init>(streamJson).find((line) => line.type === "system" && line.subtype === "init");
  return Array.isArray(init?.tools) ? init.tools.filter((tool): tool is string => typeof tool === "string") : [];
}

export function smokeScript(withPowerShell: boolean): Script {
  const bash = call("Bash", { command: `CACHE="$PWD/${CANARY}"; rm -rf "$CACHE"/`, description: "smoke command" });
  const powershell = call("PowerShell", { command: `Remove-Item -Recurse -Force ${POWERSHELL_TARGET}`, description: "smoke command" });
  return { main: [...(withPowerShell ? [powershell] : []), bash, say("done")], subagent: [] };
}

async function smoke({ checks, scratch }: Qa): Promise<void> {
  const onWindows = process.platform === "win32";
  const plugin = scratch.plugin();
  const project = scratch.project();
  mkdirSync(join(project, CANARY), { recursive: true });
  writeFileSync(join(project, CANARY, "stale.o"), "stale artifact\n");

  const logDir = scratch.dir("log");
  const debugPath = join(logDir, "debug.log");
  const script = smokeScript(onWindows);
  const mock = startMock(join(logDir, "access.log"), script);
  let result;
  try {
    result = await runClaude({
      cwd: project,
      prompt: "run the smoke",
      plugins: [plugin],
      port: mock.port,
      configDir: scratch.dir("config"),
      debugFile: debugPath,
      hookTrace: true,
      streamJson: true,
      env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" },
    });
  } finally {
    await mock.stop();
  }

  const debug = existsSync(debugPath) ? readFileSync(debugPath, "utf8") : "";
  const entries = readJsonLines<AccessEntry>(mock.accessLog);
  const served = entries.filter((entry) => entry.queue === "main" && entry.turn !== null).length;
  checks.check(result.code === 0, "claude -p exited 0", `claude -p exited ${result.code}: ${(result.stdout + result.stderr).trim().slice(0, 2000)}`);
  checks.check(served === script.main.length && localhostOnly(entries), `the mock served all ${served} scripted turns to localhost only`, `the mock served ${served} of ${script.main.length} scripted turns (entries ${entries.length})`);

  const trace = readJsonLines<TraceEntry>(join(project, ".omca", "state", "hook-trace.jsonl"));
  const calls = hookCalls(debug);
  checks.check(calls >= 1 && trace.length >= 1, `omca_hook was called ${calls} times by the client and traced ${trace.length} times by the server`, `omca_hook calls: ${calls} in the debug log, ${trace.length} in the server trace`);

  const bashDenies = guardDenies(debug, "Bash");
  checks.check(bashDenies.length === 1, "the mod's tool.check guard denied the Bash recursive removal once", `expected one tool.check Bash deny, saw ${JSON.stringify(bashDenies)}`);
  checks.check(existsSync(join(project, CANARY, "stale.o")), `${CANARY}/stale.o survived the denied command`, `${CANARY}/stale.o was removed despite the deny`);

  const powershellOffered = offeredTools(result.stdout).includes("PowerShell");
  if (onWindows && powershellOffered) {
    const denies = guardDenies(debug, "PowerShell");
    checks.check(denies.length === 1, "the mod's tool.check guard denied the PowerShell Remove-Item -Recurse once", `expected one tool.check PowerShell deny, saw ${JSON.stringify(denies)}`);
  } else if (onWindows) {
    checks.log(`NOTE: the session did not offer the PowerShell tool (tools: ${offeredTools(result.stdout).join(", ") || "none listed"}), so only the Bash deny was checked`);
  }
  const expectedDenies = 1 + (onWindows && powershellOffered ? 1 : 0);
  checks.check(pluginDenies(debug).length === expectedDenies, `the plugin denied ${expectedDenies} command(s) and nothing else`, `the plugin denied ${pluginDenies(debug).length} commands, expected ${expectedDenies}`);
}

if (import.meta.main) {
  await runQa("ci-smoke", smoke, { watchRealConfig: true });
}
