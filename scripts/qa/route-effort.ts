#!/usr/bin/env bun
// Runs a real `claude -p` with this checkout's mod against the scripted mock, whose main turn
// delegates once. The hinted run's subagent requests must carry effort `low` and a control run
// without the hint must not; main requests carry another effort in both.
//
// Usage: bun scripts/qa/route-effort.ts
// Exit: 0 pass, 1 an assertion failed, 2 the run could not be set up.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Script, startServer } from "./mock-model.ts";

const REPO = join(import.meta.dir, "..", "..");
const MODEL = "opus";
const HINT = "[omca-route effort=low]";
const CLAUDE_TIMEOUT_MS = 120_000;

type Entry = { client: string; queue: "main" | "subagent"; effort?: string | number };
type Run = { name: string; prompt: string; subagentEffort: (effort: Entry["effort"]) => boolean; expected: string };

// Under `claude -p` the Agent tool launches in the background: the main thread answers the
// launch result, then gets one more request when the subagent finishes.
function scriptFor(prompt: string): Script {
  return {
    main: [
      { content: [{ type: "tool_use", name: "Agent", input: { description: "probe", prompt, subagent_type: "general-purpose" } }] },
      { content: [{ type: "text", text: "agent launched" }] },
      { content: [{ type: "text", text: "agent finished" }] },
    ],
    subagent: [{ content: [{ type: "text", text: "hi from the subagent" }] }],
  };
}

async function runClaude(cwd: string, port: number): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DISABLE_AUTOUPDATER: "1",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: "mock-token",
    ANTHROPIC_API_KEY: undefined,
  };
  const argv = ["claude", "-p", "run the probe", "--model", MODEL, "--plugin-dir", REPO, "--setting-sources", "project,local"];
  const proc = Bun.spawn([...argv, "--permission-mode", "bypassPermissions", "--output-format", "text"], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: CLAUDE_TIMEOUT_MS,
  });
  const code = await proc.exited;
  if (code !== 0) {
    const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    throw new Error(`claude -p exited ${code}${proc.signalCode ? ` (${proc.signalCode})` : ""}: ${output.trim()}`);
  }
}

async function scenario(scratch: string, run: Run): Promise<boolean> {
  const dir = join(scratch, run.name);
  const cwd = join(dir, "cwd");
  const logPath = join(dir, "access.log");
  mkdirSync(cwd, { recursive: true });
  const server = startServer({ port: 0, accessLogPath: logPath, script: scriptFor(run.prompt) });
  try {
    await runClaude(cwd, server.port ?? 0);
  } finally {
    await server.stop(true);
  }

  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const entries = lines.map((line) => JSON.parse(line) as Entry);
  const main = entries.filter((e) => e.queue === "main");
  const subagent = entries.filter((e) => e.queue === "subagent");
  const checks: [string, boolean][] = [
    ["every request came from 127.0.0.1", entries.every((e) => e.client === "127.0.0.1")],
    ["the subagent made at least one request", subagent.length > 0],
    [`every subagent request carries ${run.expected}`, subagent.every((e) => run.subagentEffort(e.effort))],
    ["the main thread made at least one request", main.length > 0],
    ["every main request carries an effort other than low", main.every((e) => e.effort !== undefined && e.effort !== "low")],
  ];

  console.log(`${run.name}: prompt first line ${JSON.stringify(run.prompt.split("\n")[0])}`);
  for (const [index, line] of lines.entries()) {
    if (entries[index]?.queue === "subagent" || index === 0) console.log(`  ${line}`);
  }
  for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  return checks.every(([, ok]) => ok);
}

const TASK = "Say hi.";
const RUNS: Run[] = [
  { name: "hinted", prompt: `${HINT}\n${TASK}`, subagentEffort: (effort) => effort === "low", expected: "effort low" },
  {
    name: "control",
    prompt: TASK,
    subagentEffort: (effort) => effort !== undefined && effort !== "low",
    expected: "an effort other than low",
  },
];

const scratch = mkdtempSync(join(tmpdir(), "omca-route-effort-"));
try {
  const results: boolean[] = [];
  for (const run of RUNS) results.push(await scenario(scratch, run));
  process.exitCode = results.every(Boolean) ? 0 : 1;
} catch (error) {
  console.error(`route-effort: setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
