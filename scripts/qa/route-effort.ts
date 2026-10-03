#!/usr/bin/env bun
// Runs a real `claude -p` with this checkout's mod against the scripted mock, whose main turn
// delegates once. The hinted run's subagent requests must carry effort `low` and a control run
// without the hint must not; main requests carry another effort in both.
//
// Usage: bun scripts/qa/route-effort.ts
// Exit: 0 pass, 1 an assertion failed, 2 the run could not be set up.
import { join } from "node:path";
import { type Qa, readJsonLines, REPO, runClaude, runQa, startMock } from "./lib.ts";
import type { Script } from "./mock-model.ts";

const MODEL = "opus";
const HINT = "[omca-route effort=low]";

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

async function scenario({ checks, scratch }: Qa, run: Run): Promise<void> {
  const mock = startMock(join(scratch.dir("mock"), "access.log"), scriptFor(run.prompt));
  let result;
  try {
    result = await runClaude({ cwd: scratch.project(), prompt: "run the probe", plugins: [REPO], model: MODEL, port: mock.port, configDir: scratch.dir("config") });
  } finally {
    await mock.stop();
  }
  if (result.code !== 0) throw new Error(`claude -p exited ${result.code}: ${(result.stdout + result.stderr).trim()}`);

  const entries = readJsonLines<Entry>(mock.accessLog);
  const main = entries.filter((e) => e.queue === "main");
  const subagent = entries.filter((e) => e.queue === "subagent");
  const label = (text: string) => `${run.name}: ${text}`;
  checks.log(`${run.name}: prompt first line ${JSON.stringify(run.prompt.split("\n")[0])}`);
  for (const [index, entry] of entries.entries()) {
    if (entry.queue === "subagent" || index === 0) checks.log(`  ${JSON.stringify(entry)}`);
  }
  const verify = (ok: boolean, text: string) => checks.check(ok, label(text), label(text));
  verify(entries.every((e) => e.client === "127.0.0.1"), "every request came from 127.0.0.1");
  verify(subagent.length > 0, "the subagent made at least one request");
  verify(subagent.every((e) => run.subagentEffort(e.effort)), `every subagent request carries ${run.expected}`);
  verify(main.length > 0, "the main thread made at least one request");
  verify(main.every((e) => e.effort !== undefined && e.effort !== "low"), "every main request carries an effort other than low");
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

await runQa(
  "route-effort",
  async (qa) => {
    for (const run of RUNS) await scenario(qa, run);
  },
  { watchRealConfig: true },
);
