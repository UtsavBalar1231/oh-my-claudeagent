#!/usr/bin/env bun
// Runs a real `claude -p` against the scripted mock with the packaged plugin and a fixture
// plugin whose agent has `isolation: worktree`. The agent runs `pwd`; the result must be a
// worktree path, not a lost-isolation error, and the plugin's `mcp_tool` PostToolUse hook
// must have seen the agent. --unfiltered-tool-call adds a passthrough `tool.call` hook with no
// tool filter to the scratch copy of the packaged tree; Bash must keep working in the subagent.
//
// Usage: bun scripts/qa/worktree-bash.ts [--unfiltered-tool-call]
// Exit: 0 pass, 1 a check failed or a real config file changed, 2 the run could not be set up.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type AccessEntry, call, childEnv, parseJsonLines, type Qa, readJsonLines, runClaude, runQa, say, startMock, type TraceEntry } from "./lib.ts";
import type { Script } from "./mock-model.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "worktree-agent");
const AGENT_TYPE = "omca-qa-worktree:probe";
const PROBE_COMMAND = "pwd";
const CONTEXT_LOST = /isolation context.*lost/;
const WORKTREE_PATH = /\/\.claude\/worktrees\/[^/\s]+$/;
const REGISTER_HEAD = "export const register: Register = (on, pluginOptions) => {\n";
const UNFILTERED_TOOL_CALL = '  on("tool.call", ($, e, next) => next(e));\n';

type Line = Record<string, unknown>;
type Result = { text: string; isError: boolean };

const script: Script = {
  main: [call("Agent", { description: "probe", prompt: "run the command", subagent_type: AGENT_TYPE }), say("agent launched"), say("agent finished")],
  subagent: [call("Bash", { command: PROBE_COMMAND, description: "print the working directory" }), say("done")],
};

function blocks(line: Line): Line[] {
  const content = (line.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Line[]) : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? "").join("\n") : "";
}

// The subagent's Bash result is in its own transcript under the config dir, and only the
// subagent runs Bash in this scenario.
function probeResults(configDir: string): Result[] {
  const lines = [...new Bun.Glob("projects/**/*.jsonl").scanSync(configDir)].flatMap((f) => parseJsonLines<Line>(readFileSync(join(configDir, f), "utf8")));
  const ids = new Set(
    lines.flatMap(blocks).filter((b) => b.type === "tool_use" && b.name === "Bash" && (b.input as Line).command === PROBE_COMMAND).map((b) => b.id),
  );
  return lines.flatMap(blocks).filter((b) => b.type === "tool_result" && ids.has(b.tool_use_id)).map((b) => ({ text: resultText(b.content), isError: b.is_error === true }));
}

function addUnfilteredToolCall(pluginDir: string): void {
  const path = join(pluginDir, "hooks", "register.ts");
  const source = readFileSync(path, "utf8");
  if (!source.includes(REGISTER_HEAD)) throw new Error("hooks/register.ts no longer opens `register` as the unfiltered hook expects");
  writeFileSync(path, source.replace(REGISTER_HEAD, REGISTER_HEAD + UNFILTERED_TOOL_CALL));
}

async function probe({ checks, scratch }: Qa, unfilteredToolCall: boolean): Promise<void> {
  const plugin = scratch.plugin();
  if (unfilteredToolCall) addUnfilteredToolCall(plugin);
  const project = scratch.project();
  const commit = Bun.spawnSync(["git", "-C", project, "commit", "--quiet", "--allow-empty", "-m", "init"], { env: childEnv(), stdout: "pipe", stderr: "pipe" });
  if (commit.exitCode !== 0) throw new Error(`git commit exited ${commit.exitCode}: ${commit.stderr.toString().trim()}`);
  const configDir = scratch.dir("config");
  const logDir = scratch.dir("log");
  const mock = startMock(join(logDir, "access.log"), script);
  let result;
  try {
    result = await runClaude({ cwd: project, prompt: "run the probe", plugins: [plugin, FIXTURE], port: mock.port, configDir, debugFile: join(logDir, "debug.log"), hookTrace: true });
  } finally {
    await mock.stop();
  }
  if (result.code !== 0) throw new Error(`claude -p exited ${result.code}: ${(result.stdout + result.stderr).trim()}`);
  if (!readJsonLines<AccessEntry>(mock.accessLog).some((entry) => entry.queue === "subagent")) {
    throw new Error("the subagent never reached the mock model, so no assertion can run");
  }

  const results = probeResults(configDir);
  const trace = readJsonLines<TraceEntry>(join(project, ".omca", "state", "hook-trace.jsonl"));
  checks.check(results.some((r) => !r.isError && WORKTREE_PATH.test(r.text.trim())), "subagent Bash ran and printed a worktree path", `subagent Bash printed no worktree path: ${JSON.stringify(results)}`);
  checks.check(results.length > 0 && !results.some((r) => CONTEXT_LOST.test(r.text)), "subagent Bash result does not report lost isolation", `subagent Bash reported lost isolation or never ran: ${JSON.stringify(results)}`);
  checks.check(
    trace.some((entry) => entry.event === "PostToolUse" && entry.agent_type === AGENT_TYPE),
    `PostToolUse trace holds agent_type ${AGENT_TYPE}`,
    `no PostToolUse trace entry for ${AGENT_TYPE}: ${JSON.stringify(trace.map((entry) => `${entry.event}:${entry.agent_type}`))}`,
  );
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { "unfiltered-tool-call": { type: "boolean", default: false } } });
  await runQa("worktree-bash", (qa) => probe(qa, values["unfiltered-tool-call"]), { watchRealConfig: true });
}
