#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { type Script, startServer } from "./qa/mock-model.ts";

const REPO = join(import.meta.dir, "..");
const RESULTS_DIR = join(REPO, "benchmarks", "perf", "results");
const PAIRS = 50;
const WARMUP_PAIRS = 1;
const BASH_CALLS = 20;
const AGENT_CALLS = 5;
const EVIDENCE_CALLS = 20;
const SESSION_TIMEOUT_MS = 180_000;
const MCP_TIMEOUT_MS = 60_000;

export type Side = "baseline" | "candidate";
export type Arm = { pluginDir: string | null; configDir: string; dataDir: string; tmpDir: string };
export type Summary = {
  n: number;
  baseline_median: number;
  candidate_median: number;
  median_paired_diff: number;
  median_paired_diff_pct: number;
};
export type SessionLog = {
  first_request_ms: number;
  window_ms: number;
  main_requests: number;
  subagent_requests: number;
  final_tool_results: number;
};

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("median of no samples");
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function summarize(baseline: number[], candidate: number[]): Summary {
  if (baseline.length !== candidate.length) throw new Error("paired samples differ in length");
  const baselineMedian = median(baseline);
  const diff = median(candidate.map((c, i) => c - (baseline[i] as number)));
  return {
    n: baseline.length,
    baseline_median: baselineMedian,
    candidate_median: median(candidate),
    median_paired_diff: diff,
    median_paired_diff_pct: (100 * diff) / baselineMedian,
  };
}

// The side that runs first in a pair alternates, so warm-cache and drift effects do not
// always favour the same side.
export const pairOrder = (i: number): [Side, Side] =>
  i % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];

export function readSessionLog(text: string, spawnMs: number): SessionLog {
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { client: string; queue: string; tool_results: number; arrival_ms: number });
  if (lines.length === 0) throw new Error("the mock logged no request");
  const foreign = lines.filter((l) => l.client !== "127.0.0.1");
  if (foreign.length > 0) throw new Error(`requests from outside 127.0.0.1: ${foreign.map((l) => l.client).join(", ")}`);
  const arrivals = lines.map((l) => l.arrival_ms);
  const main = lines.filter((l) => l.queue === "main");
  return {
    first_request_ms: Math.min(...arrivals) - spawnMs,
    window_ms: Math.max(...arrivals) - Math.min(...arrivals),
    main_requests: main.length,
    subagent_requests: lines.length - main.length,
    final_tool_results: main.at(-1)?.tool_results ?? 0,
  };
}

type McpServerEntry = { command: string; args: string[]; env?: Record<string, string> };

export function mcpCommand(mcpJson: string, root: string, dataDir: string): { cmd: string[]; env: Record<string, string> } {
  const entry = (JSON.parse(mcpJson) as { mcpServers: Record<string, McpServerEntry> }).mcpServers.omca;
  if (!entry) throw new Error("no omca server in .mcp.json");
  const expand = (s: string) => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", root).replaceAll("${CLAUDE_PLUGIN_DATA}", dataDir);
  return {
    cmd: [entry.command, ...entry.args].map(expand),
    env: Object.fromEntries(Object.entries(entry.env ?? {}).map(([k, v]) => [k, expand(v)])),
  };
}

// A nested session must not inherit this session's id, socket or model settings.
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(CLAUDE|ANTHROPIC)/.test(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

function run(cmd: string[], cwd = REPO): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

type Packaged = { sha: string; dirty: string[] };

// The working tree can change while a bench runs, so the copy is taken once up front and
// its dirty paths are recorded with the results.
function packageTree(ref: string | null, dest: string): Packaged {
  if (ref === null) {
    const dirty = run(["git", "status", "--porcelain"]).split("\n").filter(Boolean);
    const files = run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0");
    for (const file of files.filter(Boolean)) {
      const src = join(REPO, file);
      if (!existsSync(src) || !statSync(src).isFile()) continue;
      mkdirSync(dirname(join(dest, file)), { recursive: true });
      copyFileSync(src, join(dest, file));
    }
    return { sha: run(["git", "rev-parse", "HEAD"]), dirty };
  }
  const sha = run(["git", "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  run(["git", "worktree", "add", "--detach", dest, sha]);
  return { sha, dirty: [] };
}

// The Python renderer is deployed the way omca-setup installs it: the package files under
// statusline/, the servers/tools resolver beside them, and a uv venv over the copy.
function installStatusline(root: string, dest: string): string[] {
  const bunRenderer = join(root, "statusline", "main.ts");
  if (existsSync(bunRenderer)) return ["bun", bunRenderer];
  mkdirSync(join(dest, "statusline"), { recursive: true });
  mkdirSync(join(dest, "servers", "tools"), { recursive: true });
  copyFileSync(join(root, "statusline", "pyproject.toml"), join(dest, "pyproject.toml"));
  for (const file of readdirSync(join(root, "statusline")).filter((f) => f.endsWith(".py"))) {
    copyFileSync(join(root, "statusline", file), join(dest, "statusline", file));
  }
  for (const file of ["__init__.py", "_boulder_core.py"]) {
    copyFileSync(join(root, "servers", "tools", file), join(dest, "servers", "tools", file));
  }
  run(["uv", "sync", "--quiet", "--project", dest]);
  return [join(dest, ".venv", "bin", "cc-statusline-direct")];
}

const bashScript: Script = {
  main: [
    ...Array.from({ length: BASH_CALLS }, () => ({
      content: [{ type: "tool_use" as const, name: "Bash", input: { command: "true", description: "no-op" } }],
    })),
    { content: [{ type: "text", text: "done" }] },
  ],
  subagent: [],
};

// Agent calls launch asynchronously under `claude -p`: a launch result or a completion can
// each prompt a main request (completions often fold together), so the main queue holds a
// text turn for every possible one.
const agentScript: Script = {
  main: [
    ...Array.from({ length: AGENT_CALLS }, (_, i) => ({
      content: [
        {
          type: "tool_use" as const,
          name: "Agent",
          input: { description: `probe ${i}`, prompt: "say done", subagent_type: "general-purpose" },
        },
      ],
    })),
    ...Array.from({ length: AGENT_CALLS + 1 }, () => ({ content: [{ type: "text" as const, text: "done" }] })),
  ],
  subagent: Array.from({ length: AGENT_CALLS }, () => ({ content: [{ type: "text" as const, text: "done" }] })),
};

export type Scenario = { script: Script; check: (log: SessionLog) => string | null };

export const bashScenario: Scenario = {
  script: bashScript,
  check: (log) =>
    log.final_tool_results === BASH_CALLS && log.main_requests === BASH_CALLS + 1
      ? null
      : `expected ${BASH_CALLS} Bash results in the last of ${BASH_CALLS + 1} main requests, got ${log.final_tool_results} in the last of ${log.main_requests}`,
};

export const agentScenario: Scenario = {
  script: agentScript,
  check: (log) =>
    log.subagent_requests === AGENT_CALLS ? null : `expected ${AGENT_CALLS} subagent requests, got ${log.subagent_requests}`,
};

async function runSession(arm: Arm, scenario: Scenario, scratch: string): Promise<SessionLog> {
  const cwd = mkdtempSync(join(scratch, "session-"));
  const logPath = `${cwd}.jsonl`;
  const mock = startServer({ port: 0, accessLogPath: logPath, script: scenario.script });
  try {
    const cmd = ["claude", "-p", "run the bench", "--setting-sources", "project,local", "--permission-mode", "bypassPermissions", "--output-format", "text"];
    if (arm.pluginDir) cmd.push("--plugin-dir", arm.pluginDir);
    const spawnMs = Date.now();
    const proc = Bun.spawn(cmd, {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: SESSION_TIMEOUT_MS,
      env: childEnv({
        CLAUDE_CONFIG_DIR: arm.configDir,
        DISABLE_AUTOUPDATER: "1",
        ANTHROPIC_API_KEY: "mock-key",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`,
      }),
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.trim()}`);
    if (stderr.includes("hooks module not loaded")) throw new Error(stderr.trim());
    const log = readSessionLog(readFileSync(logPath, "utf8"), spawnMs);
    const problem = scenario.check(log);
    if (problem) throw new Error(problem);
    return log;
  } finally {
    await mock.stop(true);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(logPath, { force: true });
  }
}

export type SessionPair = { order: [Side, Side]; baseline: SessionLog; candidate: SessionLog; noplugin: SessionLog };

// Each side runs with the plugin; the no-plugin control runs between them and is the
// zero both sides' overhead is measured from.
export async function measureSessions(
  arms: Record<Side | "noplugin", Arm>,
  scenario: Scenario,
  scratch: string,
): Promise<SessionPair[]> {
  const pairs: SessionPair[] = [];
  for (let i = -WARMUP_PAIRS; i < PAIRS; i++) {
    const order = pairOrder(i + WARMUP_PAIRS);
    const first = await runSession(arms[order[0]], scenario, scratch);
    const noplugin = await runSession(arms.noplugin, scenario, scratch);
    const second = await runSession(arms[order[1]], scenario, scratch);
    const bySide = { [order[0]]: first, [order[1]]: second } as Record<Side, SessionLog>;
    if (i >= 0) pairs.push({ order, ...bySide, noplugin });
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  return pairs;
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
}

export type McpSample = { cold_start_ms: number; evidence_log_ms: number };

async function mcpSession(root: string, arm: Arm, scratch: string): Promise<McpSample> {
  const { cmd, env } = mcpCommand(readFileSync(join(root, ".mcp.json"), "utf8"), root, arm.dataDir);
  const work = mkdtempSync(join(scratch, "mcp-"));
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, {
    cwd: work,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    timeout: MCP_TIMEOUT_MS,
    env: childEnv({ ...env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: arm.dataDir }),
  });
  const replies = lines(proc.stdout);
  let nextId = 1;
  const request = async (method: string, params: object): Promise<Record<string, unknown>> => {
    const id = nextId++;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    proc.stdin.flush();
    // next() rather than for-await: leaving a for-await loop would close the shared reader.
    for (let line = await replies.next(); !line.done; line = await replies.next()) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line.value) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (msg.id !== id) continue;
      if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
      return msg;
    }
    throw new Error(`the MCP server exited before answering ${method}`);
  };
  try {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bench", version: "0" },
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await request("tools/list", {});
    const coldStart = performance.now() - t0;
    const roundTrips: number[] = [];
    for (let i = 0; i < EVIDENCE_CALLS; i++) {
      const sent = performance.now();
      const reply = await request("tools/call", {
        name: "evidence_log",
        arguments: { evidence_type: "test", command: `bench ${i}`, exit_code: 0, output_snippet: "bench", working_directory: work },
      });
      roundTrips.push(performance.now() - sent);
      if ((reply.result as { isError?: boolean } | undefined)?.isError) {
        throw new Error(`evidence_log failed: ${JSON.stringify(reply.result)}`);
      }
    }
    return { cold_start_ms: coldStart, evidence_log_ms: median(roundTrips) };
  } finally {
    proc.stdin.end();
    await proc.exited;
    rmSync(work, { recursive: true, force: true });
  }
}

const STATUSLINE_PAYLOAD = (projectDir: string) => ({
  session_id: "11111111-2222-3333-4444-555555555555",
  model: { display_name: "Opus" },
  workspace: { project_dir: projectDir, current_dir: projectDir },
  context_window: {
    context_window_size: 200000,
    used_percentage: 72.5,
    current_usage: { input_tokens: 100000, cache_creation_input_tokens: 20000, cache_read_input_tokens: 5000, output_tokens: 2000 },
  },
  cost: { total_cost_usd: 1.23, total_duration_ms: 125000, total_lines_added: 42, total_lines_removed: 17 },
  effort: { level: "high" },
  thinking: { enabled: true },
});

async function renderStatusline(cmd: string[], arm: Arm, payload: string): Promise<number> {
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, {
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "ignore",
    env: childEnv({ TMPDIR: arm.tmpDir, COLUMNS: "200" }),
  });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  const elapsed = performance.now() - t0;
  // The Python renderer prints a bare "[claude]" stub on any internal error, so a real
  // render is one that shows the payload's model name.
  if (code !== 0 || !out.includes("Opus")) throw new Error(`statusline exited ${code} with output ${JSON.stringify(out)}`);
  return elapsed;
}

async function measurePairs<T>(measure: (side: Side) => Promise<T>): Promise<Record<Side, T[]>> {
  const out: Record<Side, T[]> = { baseline: [], candidate: [] };
  for (let i = -WARMUP_PAIRS; i < PAIRS; i++) {
    for (const side of pairOrder(i + WARMUP_PAIRS)) {
      const sample = await measure(side);
      if (i >= 0) out[side].push(sample);
    }
  }
  return out;
}

const fmt = (n: number) => n.toFixed(2).padStart(10);

function printTable(summary: Record<string, Summary>): void {
  console.log(`${"metric (ms)".padEnd(36)}${"baseline".padStart(10)}${"candidate".padStart(10)}${"diff".padStart(10)}${"diff %".padStart(10)}`);
  for (const [metric, s] of Object.entries(summary)) {
    console.log(`${metric.padEnd(36)}${fmt(s.baseline_median)}${fmt(s.candidate_median)}${fmt(s.median_paired_diff)}${fmt(s.median_paired_diff_pct)}`);
  }
}

const overhead = (pairs: SessionPair[], side: Side, calls: number) =>
  pairs.map((p) => (p[side].window_ms - p.noplugin.window_ms) / calls);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "baseline-ref": { type: "string" }, "candidate-ref": { type: "string" } } });
  const baselineRef = values["baseline-ref"];
  if (!baselineRef) {
    console.error("usage: just bench --baseline-ref <ref> [--candidate-ref <ref>]");
    process.exit(2);
  }
  const candidateRef = values["candidate-ref"] ?? null;
  const scratch = mkdtempSync(join(tmpdir(), "omca-bench-"));
  const worktrees: string[] = [];
  try {
    const roots = {} as Record<Side, string>;
    const packaged = {} as Record<Side, Packaged>;
    for (const [side, ref] of [["baseline", baselineRef], ["candidate", candidateRef]] as const) {
      roots[side] = join(scratch, `plugin-${side}`);
      if (ref !== null) worktrees.push(roots[side]);
      packaged[side] = packageTree(ref, roots[side]);
    }
    const arm = (name: string, pluginDir: string | null): Arm => {
      const dirs = { configDir: join(scratch, name, "config"), dataDir: join(scratch, name, "data"), tmpDir: join(scratch, name, "tmp") };
      for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
      return { pluginDir, ...dirs };
    };
    const arms = { baseline: arm("baseline", roots.baseline), candidate: arm("candidate", roots.candidate), noplugin: arm("noplugin", null) };

    console.error("bash hook overhead");
    const bashPairs = await measureSessions(arms, bashScenario, scratch);
    console.error("delegation overhead");
    const agentPairs = await measureSessions(arms, agentScenario, scratch);
    console.error("mcp");
    const mcp = await measurePairs((side) => mcpSession(roots[side], arms[side], scratch));
    console.error("statusline");
    const gitProject = join(scratch, "statusline-project");
    mkdirSync(gitProject);
    run(["git", "init", "--quiet"], gitProject);
    run(["git", "-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "--quiet", "--allow-empty", "-m", "bench"], gitProject);
    const payload = JSON.stringify(STATUSLINE_PAYLOAD(gitProject));
    const renderers = {
      baseline: installStatusline(roots.baseline, join(scratch, "baseline", "statusline")),
      candidate: installStatusline(roots.candidate, join(scratch, "candidate", "statusline")),
    };
    const statusline = await measurePairs((side) => renderStatusline(renderers[side], arms[side], payload));

    const summary: Record<string, Summary> = {
      bash_hook_overhead_per_call: summarize(overhead(bashPairs, "baseline", BASH_CALLS), overhead(bashPairs, "candidate", BASH_CALLS)),
      delegation_overhead_per_subagent: summarize(overhead(agentPairs, "baseline", AGENT_CALLS), overhead(agentPairs, "candidate", AGENT_CALLS)),
      session_start_to_first_request: summarize(
        bashPairs.map((p) => p.baseline.first_request_ms),
        bashPairs.map((p) => p.candidate.first_request_ms),
      ),
      mcp_cold_start_to_tools_list: summarize(mcp.baseline.map((s) => s.cold_start_ms), mcp.candidate.map((s) => s.cold_start_ms)),
      mcp_evidence_log_warm: summarize(mcp.baseline.map((s) => s.evidence_log_ms), mcp.candidate.map((s) => s.evidence_log_ms)),
      statusline_render: summarize(statusline.baseline, statusline.candidate),
    };
    printTable(summary);

    const label = (ref: string | null) => (ref ?? "working-tree").replace(/[^\w.-]/g, "_");
    const out = join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label(baselineRef)}-vs-${label(candidateRef)}.json`);
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          baseline: { ref: baselineRef, ...packaged.baseline },
          candidate: { ref: candidateRef ?? "working-tree", ...packaged.candidate },
          client: run(["claude", "--version"]),
          bun: Bun.version,
          pairs: PAIRS,
          summary,
          raw: { bash: bashPairs, agent: agentPairs, mcp, statusline },
        },
        null,
        2,
      )}\n`,
    );
    console.log(`results: ${out}`);
  } finally {
    for (const wt of worktrees) run(["git", "worktree", "remove", "--force", wt]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
