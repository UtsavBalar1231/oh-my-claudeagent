#!/usr/bin/env bun
// Runs a real `claude -p` against the scripted mock with the packaged plugin and a fixture
// plugin whose agent has `isolation: worktree`. The agent runs `pwd`; the result must be a
// worktree path, not a lost-isolation error, and the plugin's `mcp_tool` PostToolUse hook
// must have seen the agent. An unfiltered `tool.call` hook breaks Bash in such a subagent
// (anthropics/claude-code#92533), so --mutate-unfiltered-tool-call adds one to the scratch
// copy of the packaged tree and the run must then fail.
//
// Usage: bun scripts/qa/worktree-bash.ts [--mutate-unfiltered-tool-call]
// Exit: 0 pass, 1 an assertion failed, 2 the run could not be set up.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { packageTree } from "../package.ts";
import { type Script, startServer } from "./mock-model.ts";

const REPO = join(import.meta.dir, "..", "..");
const FIXTURE = join(import.meta.dir, "fixtures", "worktree-agent");
const AGENT_TYPE = "omca-qa-worktree:probe";
const PROBE_COMMAND = "pwd";
const CONTEXT_LOST = /isolation context.*lost/;
const WORKTREE_PATH = /\/\.claude\/worktrees\/[^/\s]+$/;
const CLAUDE_TIMEOUT_MS = 180_000;
const REGISTER_HEAD = "export const register: Register = (on, pluginOptions) => {\n";
const UNFILTERED_TOOL_CALL = '  on("tool.call", ($, e, next) => next(e));\n';

type Line = Record<string, unknown>;
type Result = { text: string; isError: boolean };

const script: Script = {
  main: [
    { content: [{ type: "tool_use", name: "Agent", input: { description: "probe", prompt: "run the command", subagent_type: AGENT_TYPE } }] },
    { content: [{ type: "text", text: "agent launched" }] },
    { content: [{ type: "text", text: "agent finished" }] },
  ],
  subagent: [
    { content: [{ type: "tool_use", name: "Bash", input: { command: PROBE_COMMAND, description: "print the working directory" } }] },
    { content: [{ type: "text", text: "done" }] },
  ],
};

// A nested session must not inherit this session's id, socket or model settings.
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(CLAUDE|ANTHROPIC)/.test(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

function run(cmd: string[], cwd: string): void {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
}

function jsonLines(path: string): Line[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);
}

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
  const lines = [...new Bun.Glob("projects/**/*.jsonl").scanSync(configDir)].flatMap((f) => jsonLines(join(configDir, f)));
  const ids = new Set(
    lines.flatMap(blocks).filter((b) => b.type === "tool_use" && b.name === "Bash" && (b.input as Line).command === PROBE_COMMAND).map((b) => b.id),
  );
  return lines.flatMap(blocks).filter((b) => b.type === "tool_result" && ids.has(b.tool_use_id)).map((b) => ({ text: resultText(b.content), isError: b.is_error === true }));
}

function mutate(pluginDir: string): void {
  const path = join(pluginDir, "hooks", "register.ts");
  const source = readFileSync(path, "utf8");
  if (!source.includes(REGISTER_HEAD)) throw new Error("hooks/register.ts no longer opens `register` as the mutation expects");
  writeFileSync(path, source.replace(REGISTER_HEAD, REGISTER_HEAD + UNFILTERED_TOOL_CALL));
}

async function main(): Promise<boolean> {
  const { values } = parseArgs({ options: { "mutate-unfiltered-tool-call": { type: "boolean", default: false } } });
  const mutated = values["mutate-unfiltered-tool-call"];
  if (!Bun.which("claude")) throw new Error("claude is not on PATH");

  const scratch = mkdtempSync(join(tmpdir(), "omca-worktree-bash-"));
  const server = startServer({ port: 0, accessLogPath: join(scratch, "access.log"), script });
  try {
    const plugin = join(scratch, "plugin");
    const project = join(scratch, "project");
    const configDir = join(scratch, "config");
    mkdirSync(project);
    mkdirSync(configDir);
    packageTree(REPO, plugin);
    if (mutated) mutate(plugin);
    run(["git", "init", "--quiet"], project);
    run(["git", "-c", "user.name=qa", "-c", "user.email=qa@localhost", "commit", "--quiet", "--allow-empty", "-m", "init"], project);

    const proc = Bun.spawn(
      [
        "claude", "-p", "run the probe",
        "--plugin-dir", plugin,
        "--plugin-dir", FIXTURE,
        "--setting-sources", "project,local",
        "--permission-mode", "bypassPermissions",
        "--output-format", "text",
        "--debug-file", join(scratch, "debug.log"),
      ],
      {
        cwd: project,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: CLAUDE_TIMEOUT_MS,
        env: childEnv({
          CLAUDE_CONFIG_DIR: configDir,
          DISABLE_AUTOUPDATER: "1",
          OMCA_HOOK_TRACE: "1",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
          ANTHROPIC_AUTH_TOKEN: "mock-token",
        }),
      },
    );
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`claude -p exited ${code}${proc.signalCode ? ` (${proc.signalCode})` : ""}: ${(stdout + stderr).trim()}`);
    if (!jsonLines(join(scratch, "access.log")).some((l) => l.queue === "subagent")) {
      throw new Error("the subagent never reached the mock model, so no assertion can run");
    }

    const results = probeResults(configDir);
    const tracePath = join(project, ".omca", "state", "hook-trace.jsonl");
    const trace = (await Bun.file(tracePath).exists()) ? jsonLines(tracePath) : [];
    const checks: [string, boolean, string][] = [
      ["subagent Bash ran and printed a worktree path", results.some((r) => !r.isError && WORKTREE_PATH.test(r.text.trim())), JSON.stringify(results)],
      ["subagent Bash result does not report lost isolation", results.length > 0 && !results.some((r) => CONTEXT_LOST.test(r.text)), JSON.stringify(results)],
      [
        `PostToolUse trace holds agent_type ${AGENT_TYPE}`,
        trace.some((l) => l.event === "PostToolUse" && l.agent_type === AGENT_TYPE),
        JSON.stringify(trace.map((l) => `${l.event}:${l.agent_type}`)),
      ],
    ];
    for (const [label, ok, observed] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (observed ${observed})`}`);
    return checks.every(([, ok]) => ok);
  } finally {
    await server.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  process.exitCode = (await main()) ? 0 : 1;
} catch (error) {
  console.error(`worktree-bash: setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
