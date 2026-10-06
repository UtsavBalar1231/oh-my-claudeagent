#!/usr/bin/env bun
// Runs a real `claude -p` with this checkout loaded against the scripted mock, whose main turn
// delegates once to OMCA's executor. With the Agent call's `effort` input set to `low`, every
// subagent request must carry low; a control run without the input must carry the executor's
// declared `high`. The first main request's Agent tool schema must offer `effort`.
//
// Usage: bun scripts/qa/agent-effort.ts
// Exit: 0 pass, 1 an assertion failed, 2 the run could not be set up.
import { join } from "node:path";
import { type BodyEntry, type Qa, readJsonLines, REPO, runClaude, runQa, startMock } from "./lib.ts";
import type { Script } from "./mock-model.ts";

const MODEL = "opus";
const AGENT = "oh-my-claudeagent:executor";
const LEVELS = ["low", "medium", "high", "xhigh", "max"];

type Entry = { client: string; queue: "main" | "subagent" | "side"; effort?: string | number };
type Run = { name: string; effort?: string; expected: string };

// Under `claude -p` the Agent tool launches in the background: the main thread answers the
// launch result, then gets one more request when the subagent finishes.
function scriptFor(run: Run): Script {
  const input = { description: "probe", prompt: "Say hi.", subagent_type: AGENT, ...(run.effort === undefined ? {} : { effort: run.effort }) };
  return {
    main: [
      { content: [{ type: "tool_use", name: "Agent", input }] },
      { content: [{ type: "text", text: "agent launched" }] },
      { content: [{ type: "text", text: "agent finished" }] },
    ],
    subagent: [{ content: [{ type: "text", text: "hi from the subagent" }] }],
  };
}

function agentEffortEnum(bodies: BodyEntry[]): unknown {
  const first = bodies.find((entry) => entry.queue === "main");
  if (first === undefined) return undefined;
  const body = JSON.parse(first.body) as { tools?: { name?: string; input_schema?: { properties?: { effort?: { enum?: unknown } } } }[] };
  return body.tools?.find((tool) => tool.name === "Agent")?.input_schema?.properties?.effort?.enum;
}

async function scenario({ checks, scratch }: Qa, run: Run): Promise<void> {
  const dir = scratch.dir(run.name);
  const bodyLog = join(dir, "bodies.log");
  const mock = startMock(join(dir, "access.log"), scriptFor(run), bodyLog);
  let result;
  try {
    result = await runClaude({ cwd: scratch.project(), prompt: "run the probe", plugins: [REPO], model: MODEL, port: mock.port, configDir: join(dir, "config") });
  } finally {
    await mock.stop();
  }
  if (result.code !== 0) throw new Error(`claude -p exited ${result.code}: ${(result.stdout + result.stderr).trim()}`);

  const entries = readJsonLines<Entry>(mock.accessLog);
  const subagent = entries.filter((e) => e.queue === "subagent");
  const schema = agentEffortEnum(readJsonLines<BodyEntry>(bodyLog));
  checks.log(`${run.name}: Agent effort input ${JSON.stringify(run.effort ?? null)}; schema enum ${JSON.stringify(schema ?? null)}`);
  for (const entry of subagent) checks.log(`  ${JSON.stringify(entry)}`);
  const verify = (ok: boolean, text: string) => checks.check(ok, `${run.name}: ${text}`, `${run.name}: ${text}`);
  verify(entries.every((e) => e.client === "127.0.0.1"), "every request came from 127.0.0.1");
  verify(JSON.stringify(schema) === JSON.stringify(LEVELS), `the Agent tool schema offers effort ${LEVELS.join("|")}`);
  verify(subagent.length > 0, "the subagent made at least one request");
  verify(subagent.every((e) => e.effort === run.expected), `every subagent request carries effort ${run.expected}`);
}

const RUNS: Run[] = [
  { name: "effort-low", effort: "low", expected: "low" },
  { name: "control", expected: "high" },
];

await runQa(
  "agent-effort",
  async (qa) => {
    for (const run of RUNS) await scenario(qa, run);
  },
  { watchRealConfig: true },
);
