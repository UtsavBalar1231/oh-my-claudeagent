#!/usr/bin/env bun
// One headless `claude -p` turn with the packaged plugin loaded, against the mock model by
// default: the reply is the mock's scripted text, the plugin's state directory appears in the
// scratch project, and every request the mock logged came from 127.0.0.1.
//
// A real-API turn runs only with QA_FORCE_REAL_API=1 and QA_ALLOW_REAL_API=1 together, with the
// user's own config dir and credentials. With QA_FORCE_REAL_API=1 alone the script skips and exits 0.
//
// Usage: bun scripts/qa/session-smoke.ts
// Exit: 0 pass or skipped, 1 a check failed, 2 the run could not be set up.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type AccessEntry, type Checks, claudeBin, localhostOnly, type Qa, readJsonLines, runClaude, runQa, startMock } from "./lib.ts";

const KNOWN_AGENTS = ["executor", "explorer", "build-fixer", "researcher", "architect", "planner", "orchestrator", "analyzer", "reviewer"];
const MIN_AGENT_NAMES = 2;
const REAL_API_TIMEOUT_MS = 180_000;

function checkStateDir(checks: Checks, project: string): void {
  checks.check(existsSync(join(project, ".omca", "state")), ".omca/state/ was created in the scratch project", ".omca/state/ was not created in the scratch project");
}

async function mockSmoke({ checks, scratch }: Qa): Promise<void> {
  const project = scratch.project();
  const plugin = scratch.plugin();
  const mock = startMock(join(scratch.dir("mock"), "access.log"));
  let result;
  try {
    result = await runClaude({ cwd: project, prompt: "reply with the single word ok", plugins: [plugin], port: mock.port, configDir: scratch.dir("config") });
  } finally {
    await mock.stop();
  }
  const reply = result.stdout.trim();
  checks.check(reply === "ok", "mock-backed turn returned the deterministic scripted text", `mock-backed turn returned unexpected output (exit ${result.code}): ${reply} ${result.stderr.trim()}`);
  checkStateDir(checks, project);

  const entries = readJsonLines<AccessEntry>(mock.accessLog);
  const hits = entries.filter((entry) => entry.path.startsWith("/v1/messages")).length;
  checks.check(
    hits >= 1 && localhostOnly(entries),
    `mock access log shows ${hits} localhost-only /v1/messages hit(s)`,
    `mock access log check failed: hits=${hits} entries=${entries.length} non_localhost=${entries.filter((entry) => entry.client !== "127.0.0.1").length}`,
  );
}

async function realApiSmoke({ checks, scratch }: Qa): Promise<void> {
  const project = scratch.project();
  const plugin = scratch.plugin();
  const proc = Bun.spawn(
    [
      claudeBin(),
      "-p",
      "Call the agents_list tool from the omca MCP server and print only the returned agent names, one per line, no other commentary.",
      "--plugin-dir",
      plugin,
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "text",
    ],
    { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: REAL_API_TIMEOUT_MS },
  );
  const [, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const output = stdout + stderr;
  const hits = KNOWN_AGENTS.filter((name) => output.includes(name)).length;
  checks.check(hits >= MIN_AGENT_NAMES, `session surface shows ${hits} known OMCA agent names`, `session surface shows only ${hits} known OMCA agent name(s), expected >= ${MIN_AGENT_NAMES}`);
  checkStateDir(checks, project);
}

if (import.meta.main) {
  await runQa(
    "session-smoke",
    async (qa) => {
      if (process.env.QA_FORCE_REAL_API !== "1") {
        qa.checks.log("running the mock-backed smoke");
        await mockSmoke(qa);
      } else if (process.env.QA_ALLOW_REAL_API === "1") {
        qa.checks.log("QA_ALLOW_REAL_API=1: running the real-API smoke");
        await realApiSmoke(qa);
      } else {
        qa.checks.log("SKIPPED: QA_FORCE_REAL_API=1 asks for a real-API turn and QA_ALLOW_REAL_API is not 1");
      }
    },
    { watchRealConfig: true },
  );
}
