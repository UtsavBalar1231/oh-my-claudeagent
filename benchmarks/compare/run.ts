#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { blockedBy, breakdown, type Breakdown, diffSnapshots, tokens, totalChars, parseConnectTrace, parseExecveTrace, parseSnapshot, type SnapDiff } from "./analyze.ts";
import {
  type Arm,
  CACHE,
  baseImage,
  ensureNetwork,
  HERE,
  imageFor,
  leftoverContainers,
  loadArms,
  prepareTree,
  readText,
  run,
  runInstall,
  runSession,
  type SessionResult,
  templateDir,
} from "./harness.ts";
import { type EvalOptions, DEFAULT_BATCH_SIZE, DEFAULT_BUDGET_USD, DEFAULT_MAX_TURNS, DEFAULT_MODEL, DEFAULT_RUNS_PER_CASE, DEFAULT_TIMEOUT_S, runEval, runRehearsal, selectCases, writeEvalReport } from "./eval.ts";
import { renderMarkdown } from "./report.ts";
import { guardCases, guardScript, type GuardCase, sessions, STOP_PLAN_PATH, STOP_SESSION_ID, stopExpectedRequests, stopScript } from "./scenarios.ts";

const USAGE = `Usage: bun benchmarks/compare/run.ts <command> [options]
Commands: build, prepare, install, online, first-run, timing, toolsearch, keywords, guards, stop, nobun, report, all,
          eval, eval-report
Options:  --arm <id> (repeatable)   --rounds <n> (default 10)   --date <YYYY-MM-DD>   --keep-raw
Eval:     --real   --rehearse   --token-file <path>   --confirm-runs <n>   --batch-size <n> (default ${DEFAULT_BATCH_SIZE})
          --case <id> (repeatable)   --runs-per-case <n> (default ${DEFAULT_RUNS_PER_CASE})   --model <id> (default ${DEFAULT_MODEL})
          --effort <level>   --max-turns <n> (default ${DEFAULT_MAX_TURNS})   --max-budget-usd <n> (default ${DEFAULT_BUDGET_USD})   --timeout <seconds> (default ${DEFAULT_TIMEOUT_S})`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    arm: { type: "string", multiple: true },
    rounds: { type: "string", default: "10" },
    date: { type: "string", default: new Date().toLocaleDateString("en-CA") },
    "keep-raw": { type: "boolean", default: false },
    real: { type: "boolean", default: false },
    rehearse: { type: "boolean", default: false },
    "token-file": { type: "string" },
    "confirm-runs": { type: "string" },
    "batch-size": { type: "string", default: String(DEFAULT_BATCH_SIZE) },
    case: { type: "string", multiple: true },
    "runs-per-case": { type: "string", default: String(DEFAULT_RUNS_PER_CASE) },
    model: { type: "string", default: DEFAULT_MODEL },
    effort: { type: "string" },
    "max-turns": { type: "string", default: String(DEFAULT_MAX_TURNS) },
    "max-budget-usd": { type: "string", default: String(DEFAULT_BUDGET_USD) },
    timeout: { type: "string", default: String(DEFAULT_TIMEOUT_S) },
  },
  allowPositionals: true,
});

const file = loadArms();
const date = values.date as string;
const rounds = Number(values.rounds);
const selected = (values.arm ?? []).length === 0 ? file.arms : file.arms.filter((arm) => values.arm?.includes(arm.id));
const runsDir = join(CACHE, "runs", date);
const resultsDir = join(HERE, "results");
const rawDir = join(resultsDir, `${date}-raw`);

const log = (text: string): void => console.log(`[compare ${new Date().toISOString().slice(11, 19)}] ${text}`);
const jsonPath = (name: string): string => join(runsDir, `${name}.json`);
const readJson = <T>(name: string, fallback: T): T => (existsSync(jsonPath(name)) ? (JSON.parse(readFileSync(jsonPath(name), "utf8")) as T) : fallback);
const writeJson = (name: string, value: unknown): void => writeFileSync(jsonPath(name), `${JSON.stringify(value, null, 1)}\n`);
const installed = (arm: Arm): boolean => arm.tree === null || existsSync(templateDir(arm.id));
const lastOf = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

export type InstallRecord = {
  arm: string;
  ok: boolean;
  steps: { step: number; cmd: string; rc: number; ms: number; error: string }[];
  install_ms: number;
  cache_bytes: number;
  cache_files: number;
  node_modules_files: number;
  config_bytes: number;
  details: Record<string, string>;
  outside_plugin_dir: SnapDiff;
  network: { hosts: string[]; connects: string[] };
  settings_keys: string[];
  online: { install_ms: number; cache_bytes: number; cache_files: number; node_modules_files: number; node_modules_bytes: number } | null;
};

const dirBytes = (path: string): number => (existsSync(path) ? Number(run(["du", "-sb", path]).split("\t")[0]) : 0);
const fileCount = (path: string, extra: string[] = []): number =>
  existsSync(path) ? run(["find", path, ...extra, "-type", "f"]).split("\n").filter(Boolean).length : 0;

const PLUGIN_DIR = "/cfg/plugins/cache/";
const hostFilter = (hosts: string[]): string[] => hosts.filter((h) => !/\.ts\.net$/.test(h));

async function installStage(): Promise<void> {
  ensureNetwork(file);
  const records = readJson<Record<string, InstallRecord>>("install", {});
  for (const arm of selected) {
    if (arm.tree === null) continue;
    log(`install ${arm.id}`);
    const traced = await runInstall(file, arm, { snap: false, traceConnect: true });
    const traceText = readdirSync(join(traced.out, "install"))
      .filter((name) => name.startsWith("connect-"))
      .map((name) => readText(join(traced.out, "install", name)))
      .join("\n");
    const network = parseConnectTrace(traceText, [file.network.gateway]);
    const result = await runInstall(file, arm, { snap: true, traceConnect: false });
    const out = result.out;
    const steps = result.steps.map((s) => ({ ...s, error: readText(join(out, "install", `${s.step}.err`)).trim().slice(0, 600) }));
    const diff = diffSnapshots(parseSnapshot(readText(join(out, "snap-0-before.tsv"))), parseSnapshot(readText(join(out, "snap-1-after-install.tsv"))));
    const keep = (paths: string[]): string[] => paths.filter((p) => !p.startsWith(PLUGIN_DIR));
    const config = templateDir(arm.id);
    const settings = readText(join(config, "settings.json"));
    const details: Record<string, string> = {};
    for (const step of steps.filter((s) => s.cmd.startsWith("claude plugin details "))) {
      details[step.cmd.replace("claude plugin details ", "")] = readText(join(out, "install", `${step.step}.out`));
    }
    records[arm.id] = {
      arm: arm.id,
      ok: result.dockerRc === 0 && steps.length > 0 && steps.every((s) => s.rc === 0),
      steps,
      install_ms: steps.filter((s) => s.cmd.startsWith("claude plugin install") || s.cmd.startsWith("claude plugin marketplace")).reduce((n, s) => n + s.ms, 0),
      cache_bytes: dirBytes(join(config, "plugins", "cache")),
      cache_files: fileCount(join(config, "plugins", "cache")),
      node_modules_files: fileCount(join(config, "plugins", "cache"), ["-path", "*/node_modules/*"]),
      config_bytes: dirBytes(config),
      details,
      outside_plugin_dir: { created: keep(diff.created), modified: keep(diff.modified), deleted: keep(diff.deleted) },
      network: { hosts: hostFilter(network.hosts), connects: network.connects },
      settings_keys: settings === "" ? [] : Object.keys(JSON.parse(settings) as Record<string, unknown>),
      online: null,
    };
    writeJson("install", records);
    log(`install ${arm.id}: ok=${records[arm.id]?.ok}`);
  }
}

async function onlineStage(): Promise<void> {
  const records = readJson<Record<string, InstallRecord>>("install", {});
  for (const arm of selected) {
    const record = records[arm.id];
    if (arm.tree === null || record === undefined || !record.network.hosts.some((h) => h.includes("registry.npmjs.org"))) continue;
    log(`online install probe ${arm.id}`);
    const result = await runInstall(file, arm, { snap: false, traceConnect: false, online: true });
    const config = join(result.out, "config");
    const cache = join(config, "plugins", "cache");
    const nodeModules = run(["find", cache, "-type", "d", "-name", "node_modules", "-prune"]).split("\n").filter(Boolean);
    record.online = {
      install_ms: result.steps.filter((s) => s.cmd.startsWith("claude plugin install")).reduce((n, s) => n + s.ms, 0),
      cache_bytes: dirBytes(cache),
      cache_files: fileCount(cache),
      node_modules_files: nodeModules.reduce((n, d) => n + fileCount(d), 0),
      node_modules_bytes: nodeModules.reduce((n, d) => n + dirBytes(d), 0),
    };
    writeJson("install", records);
    rmSync(result.out, { recursive: true, force: true });
    log(`online install probe ${arm.id}: ${JSON.stringify(record.online)}`);
  }
}

export type FirstRunRecord = {
  arm: string;
  rc: number;
  debug_errors: number;
  debug_error_samples: string[];
  registered: string;
  mods: { module: string; events: string }[];
  session_diff: SnapDiff;
  project_diff: SnapDiff;
  network: { hosts: string[]; connects: string[] };
  exec_a: { total: number; byExe: Record<string, number> } | null;
  exec_b: { total: number; byExe: Record<string, number> } | null;
};

async function firstRunStage(): Promise<void> {
  ensureNetwork(file);
  const records = readJson<Record<string, FirstRunRecord>>("first-run", {});
  const scenarioA = sessions.find((s) => s.name === "a");
  const scenarioB = sessions.find((s) => s.name === "b");
  if (scenarioA === undefined || scenarioB === undefined) throw new Error("scenarios a and b are required");
  for (const arm of selected) {
    if (!installed(arm)) continue;
    log(`first-run ${arm.id}`);
    const base = join(runsDir, "first-run", arm.id);
    const first = await runSession(file, { arm, prompt: scenarioA.prompt, script: scenarioA.script, out: join(base, "snap"), snap: true, debugHooks: true, timeoutS: 150 });
    const debug = readText(join(base, "snap", "debug.log")).split("\n");
    const errors = debug.filter((l) => l.includes("[ERROR]"));
    const registered = debug.find((l) => /Registered \d+ hooks from \d+ plugins/.test(l))?.replace(/^\S+ \[DEBUG\] /, "") ?? "";
    const mods = debug
      .map((l) => /hooks module (\S+) loaded \(([^)]*)\); events: (.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null && !(m[1] as string).endsWith("@builtin"))
      .map((m) => ({ module: m[1] as string, events: m[3] as string }));
    const s0 = parseSnapshot(readText(join(base, "snap", "snap-s0-before-session.tsv")));
    const s2 = parseSnapshot(readText(join(base, "snap", "snap-s2-after-session.tsv")));
    const diff = diffSnapshots(s0, s2);
    const inProject = (p: string): boolean => p.startsWith("/work/project/") && !p.startsWith("/work/project/.git/");
    const outside = (paths: string[]): string[] => paths.filter((p) => !p.startsWith(PLUGIN_DIR) && !p.startsWith("/work/project/.git/") && !p.startsWith("/work/project/"));
    const sessionDiff: SnapDiff = { created: outside(diff.created), modified: outside(diff.modified), deleted: outside(diff.deleted) };
    const projectDiff: SnapDiff = { created: diff.created.filter(inProject), modified: diff.modified.filter(inProject), deleted: diff.deleted.filter(inProject) };

    const connect = await runSession(file, { arm, prompt: scenarioA.prompt, script: scenarioA.script, out: join(base, "connect"), trace: "connect", timeoutS: 150 });
    const net = parseConnectTrace(readText(join(connect.out, "connect.txt")), [file.network.gateway]);
    const execA = await runSession(file, { arm, prompt: scenarioA.prompt, script: scenarioA.script, out: join(base, "exec-a"), trace: "execve", timeoutS: 150 });
    const execB = await runSession(file, { arm, prompt: scenarioB.prompt, script: scenarioB.script, out: join(base, "exec-b"), trace: "execve", timeoutS: arm.limited?.timeoutS ?? 150 });
    records[arm.id] = {
      arm: arm.id,
      rc: first.meta?.rc ?? -1,
      debug_errors: errors.length,
      debug_error_samples: errors.slice(0, 4).map((l) => l.replace(/^\S+ /, "").slice(0, 220)),
      registered,
      mods,
      session_diff: sessionDiff,
      project_diff: projectDiff,
      network: { hosts: hostFilter(net.hosts), connects: net.connects },
      exec_a: execA.meta?.rc === 0 ? parseExecveTrace(readText(join(execA.out, "strace.txt"))) : null,
      exec_b: execB.meta?.rc === 0 ? parseExecveTrace(readText(join(execB.out, "strace.txt"))) : null,
    };
    writeJson("first-run", records);
    if (!values["keep-raw"]) rmSync(base, { recursive: true, force: true });
  }
}

export type TimingRecord = {
  arm: string;
  kind: string;
  round: number;
  rc: number;
  requests: number;
  first_request_ms: number | null;
  window_ms: number | null;
  wall_ms: number | null;
  tools_n: number | null;
  tools_mcp_n: number | null;
  first: Breakdown | null;
  last: Breakdown | null;
  final_tool_results: number;
  foreign_clients: string[];
  stderr: string;
};

const rotate = <T>(xs: T[], by: number): T[] => xs.map((_, i) => xs[(i + by) % xs.length] as T);

function toolResultsIn(body: Record<string, unknown> | undefined): number {
  const messages = Array.isArray(body?.messages) ? (body?.messages as unknown[]) : [];
  const lastUser = messages.findLast((m) => typeof m === "object" && m !== null && (m as { role?: string }).role === "user") as { content?: unknown } | undefined;
  return Array.isArray(lastUser?.content) ? lastUser.content.filter((b) => (b as { type?: string }).type === "tool_result").length : 0;
}

function timingRecord(arm: Arm, kind: string, round: number, r: SessionResult): TimingRecord {
  const first = r.recorded[0];
  const last = lastOf(r.recorded);
  const startMs = r.meta === null ? null : r.meta.start_ns / 1e6;
  return {
    arm: arm.id,
    kind,
    round,
    rc: r.meta?.rc ?? -1,
    requests: r.recorded.length,
    first_request_ms: first === undefined || startMs === null ? null : first.arrival_ms - startMs,
    window_ms: first === undefined || last === undefined ? null : last.arrival_ms - first.arrival_ms,
    wall_ms: r.meta === null ? null : (r.meta.end_ns - r.meta.start_ns) / 1e6,
    tools_n: first === undefined ? null : Array.isArray(first.body.tools) ? first.body.tools.length : 0,
    tools_mcp_n: first === undefined ? null : breakdown(first.body).tools_mcp_n,
    first: first === undefined ? null : breakdown(first.body),
    last: last === undefined ? null : breakdown(last.body),
    final_tool_results: toolResultsIn(last?.body),
    foreign_clients: [...new Set(r.clients)].filter((c) => !c.startsWith("172.31.77.")),
    stderr: r.stderr.slice(0, 200),
  };
}

async function timingStage(): Promise<void> {
  ensureNetwork(file);
  mkdirSync(rawDir, { recursive: true });
  const path = join(runsDir, "timing.jsonl");
  const done = new Set<string>();
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line) as TimingRecord;
      done.add(`${r.arm}/${r.kind}/${r.round}`);
    }
  }
  const arms = selected.filter(installed);
  for (let round = -1; round < rounds; round++) {
    for (const scenario of sessions) {
      for (const arm of rotate(arms, round + 1)) {
        const limit = arm.limited;
        const limitedHere = limit?.sessions.includes(scenario.name) === true;
        if (limit !== undefined && limitedHere && (round < 0 || round >= limit.rounds)) continue;
        const key = `${arm.id}/${scenario.name}/${round}`;
        if (done.has(key)) continue;
        const out = join(runsDir, "timing", `${arm.id}-${scenario.name}-${round}`);
        const result = await runSession(file, {
          arm,
          prompt: scenario.prompt,
          script: scenario.script,
          out,
          timeoutS: limitedHere ? limit?.timeoutS ?? 150 : 150,
        });
        const record = timingRecord(arm, scenario.name, round, result);
        appendFileSync(path, `${JSON.stringify(record)}\n`);
        if (round === 0) {
          for (const [label, request] of [["first", result.recorded[0]], ["last", lastOf(result.recorded)]] as const) {
            if (request !== undefined) writeFileSync(join(rawDir, `${arm.id}-${scenario.name}-${label}.json`), JSON.stringify(request.body));
          }
        }
        rmSync(out, { recursive: true, force: true });
        rmSync(`${out}.access.jsonl`, { force: true });
        log(`round ${round} ${scenario.name} ${arm.id}: rc=${record.rc} req=${record.requests} first=${record.first_request_ms?.toFixed(0)}ms window=${record.window_ms?.toFixed(0)}ms`);
      }
    }
  }
}

export type ToolSearchRecord = { arm: string; round: number; rc: number; tools_n: number | null; first: Breakdown | null };

const PROBE_ROUNDS = 3;
const KEYWORD_PROBE_PROMPT = "autopilot ralph ultrawork ultrathink: create plan, plan this task, fix build, then reply with the single word ok.";

async function probeStage(name: string, prompt: string, env: Record<string, string>): Promise<void> {
  ensureNetwork(file);
  const path = join(runsDir, `${name}.jsonl`);
  const done = new Set(
    existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => {
          const r = JSON.parse(l) as ToolSearchRecord;
          return `${r.arm}/${r.round}`;
        })
      : [],
  );
  const scenario = sessions.find((s) => s.name === "a");
  if (scenario === undefined) throw new Error("scenario a is required");
  const arms = selected.filter(installed);
  for (let round = 0; round < PROBE_ROUNDS; round++) {
    for (const arm of rotate(arms, round)) {
      if (done.has(`${arm.id}/${round}`)) continue;
      const out = join(runsDir, name, `${arm.id}-${round}`);
      const result = await runSession(file, { arm, prompt, script: scenario.script, out, env, timeoutS: 150 });
      const first = result.recorded[0];
      const record: ToolSearchRecord = {
        arm: arm.id,
        round,
        rc: result.meta?.rc ?? -1,
        tools_n: first === undefined ? null : Array.isArray(first.body.tools) ? first.body.tools.length : 0,
        first: first === undefined ? null : breakdown(first.body),
      };
      appendFileSync(path, `${JSON.stringify(record)}\n`);
      rmSync(out, { recursive: true, force: true });
      rmSync(`${out}.access.jsonl`, { force: true });
      log(`${name} round ${round} ${arm.id}: tools=${record.tools_n}`);
    }
  }
}

const toolSearchStage = (): Promise<void> => probeStage("toolsearch", scenarioPrompt("a"), { ENABLE_TOOL_SEARCH: "true" });
const keywordStage = (): Promise<void> => probeStage("keywords", KEYWORD_PROBE_PROMPT, {});

function scenarioPrompt(name: string): string {
  const scenario = sessions.find((s) => s.name === name);
  if (scenario === undefined) throw new Error(`scenario ${name} is required`);
  return scenario.prompt;
}

export type GuardRecord = {
  arm: string;
  id: string;
  command: string;
  destructive: boolean;
  ran: boolean;
  blocked_by: string;
  result_text: string;
  is_error: boolean;
  attempts: number;
  blocked_first: boolean;
};

function resultTexts(body: Record<string, unknown> | undefined): { text: string; isError: boolean } {
  const messages = Array.isArray(body?.messages) ? (body?.messages as unknown[]) : [];
  const lastUser = messages.findLast((m) => typeof m === "object" && m !== null && (m as { role?: string }).role === "user") as { content?: unknown } | undefined;
  const blocks = Array.isArray(lastUser?.content) ? (lastUser.content as { type?: string; content?: unknown; is_error?: boolean }[]) : [];
  const results = blocks.filter((b) => b.type === "tool_result");
  const text = results
    .map((b) => (typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => (c as { text?: string }).text ?? "").join("") : ""))
    .join("\n");
  return { text, isError: results.some((b) => b.is_error === true) };
}

function guardRan(guard: GuardCase, text: string, isError: boolean, out: string): boolean {
  const read = (name: string): string => readText(join(out, name)).trim();
  switch (guard.id) {
    case "rm-rf-root":
      return /dangerous to operate recursively/.test(text);
    case "rm-rf-home":
      return read("sentinel_after.txt") === "absent";
    case "git-reset-hard":
      return !read("status_after.txt").includes("tracked.txt");
    case "git-push-force":
      return read("remote_after.txt") !== read("remote_before.txt");
    case "git-commit-no-verify":
      return read("head_after.txt") !== read("head_before.txt");
    case "rm-rf-build":
      return read("build_after.txt") === "absent";
    case "git-status":
      return /On branch/.test(text) && !isError;
    default:
      return /fixture\.txt/.test(text) && !isError;
  }
}

const DENIAL = /denied by plugin|hook error|Dangerous rm operation/;

async function guardsStage(): Promise<void> {
  ensureNetwork(file);
  const records = readJson<GuardRecord[]>("guards", []);
  for (const arm of selected.filter(installed)) {
    const attempts = arm.limited === undefined ? 2 : 1;
    for (const guard of guardCases) {
      if (records.some((r) => r.arm === arm.id && r.id === guard.id)) continue;
      const out = join(runsDir, "guards", `${arm.id}-${guard.id}`);
      const result = await runSession(file, { arm, prompt: "Run the command.", script: guardScript(guard.command, attempts === 2), out, timeoutS: attempts === 2 ? 120 : 200 });
      const first = resultTexts(result.recorded[1]?.body);
      const last = resultTexts(lastOf(result.recorded)?.body);
      const text = attempts === 2 ? `${first.text}\n${last.text}` : last.text;
      const isError = attempts === 2 ? first.isError && last.isError : last.isError;
      const ran = guardRan(guard, text, isError, out);
      records.push({
        arm: arm.id,
        id: guard.id,
        command: guard.command,
        destructive: guard.destructive,
        ran,
        blocked_by: blockedBy(first.text),
        result_text: first.text.slice(0, 400),
        is_error: isError,
        attempts,
        blocked_first: first.isError && DENIAL.test(first.text),
      });
      writeJson("guards", records);
      log(`guard ${arm.id} ${guard.id}: ${ran ? (records.at(-1)?.blocked_first ? "RAN on retry" : "RAN") : "blocked"}`);
      rmSync(out, { recursive: true, force: true });
      rmSync(`${out}.access.jsonl`, { force: true });
    }
  }
}

export type NoBunRecord = {
  mcp_tools: number | null;
  first_request_tokens: number | null;
  hook_context_tokens: number | null;
  system_tokens: number | null;
  guards: { id: string; ran: boolean; text: string }[];
  stop_forced: boolean;
  stderr: string;
};

const MASK_BUN = ["-v", "/dev/null:/usr/local/bin/bun:ro"];

async function noBunStage(): Promise<void> {
  ensureNetwork(file);
  const arm = file.arms.find((a) => a.id === "omca");
  const scenario = sessions.find((s) => s.name === "a");
  if (arm === undefined || scenario === undefined || !installed(arm)) return;
  const first = await runSession(file, { arm, prompt: scenario.prompt, script: scenario.script, out: join(runsDir, "nobun", "a"), dockerArgs: MASK_BUN, timeoutS: 120 });
  const b = first.recorded[0] === undefined ? null : breakdown(first.recorded[0].body);
  const guards: NoBunRecord["guards"] = [];
  for (const guard of guardCases.filter((g) => ["rm-rf-root", "git-reset-hard"].includes(g.id))) {
    const out = join(runsDir, "nobun", guard.id);
    const result = await runSession(file, { arm, prompt: "Run the command.", script: guardScript(guard.command, false), out, dockerArgs: MASK_BUN, timeoutS: 120 });
    const { text, isError } = resultTexts(lastOf(result.recorded)?.body);
    guards.push({ id: guard.id, ran: guardRan(guard, text, isError, out), text: text.slice(0, 200) });
  }
  const stopOut = join(runsDir, "nobun", "stop");
  const stop = await runSession(file, { arm, prompt: "Write the plan file, then stop.", script: stopScript(arm.id), out: stopOut, sessionId: STOP_SESSION_ID, dockerArgs: MASK_BUN, timeoutS: 120 });
  const record: NoBunRecord = {
    mcp_tools: b?.tools_mcp_n ?? null,
    first_request_tokens: b === null ? null : tokens(totalChars(b)),
    hook_context_tokens: b === null ? null : tokens(b.chars.hook_context),
    system_tokens: b === null ? null : tokens(b.chars.system_prompt),
    guards,
    stop_forced: continuationAfterDone(stop.recorded.map((r) => r.body)) !== null,
    stderr: first.stderr.slice(0, 200),
  };
  writeJson("nobun", record);
  log(`nobun: ${JSON.stringify(record)}`);
  rmSync(join(runsDir, "nobun"), { recursive: true, force: true });
}

export type StopRecord = {
  arm: string;
  requests: number;
  expected_requests: number;
  forced_continue: boolean;
  plan_written: boolean;
  gate_text: string;
  tool_results: string;
};

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (b as { text?: string }).text ?? "").join("\n") : "";

function continuationAfterDone(bodies: Record<string, unknown>[]): string | null {
  const mainSystem = JSON.stringify(bodies[0]?.system);
  for (const body of bodies) {
    if (JSON.stringify(body.system) !== mainSystem) continue;
    const messages = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
    const at = messages.findLastIndex((m) => m.role === "assistant" && textOf(m.content).trim() === "done");
    if (at < 0) continue;
    const tail = messages.slice(at + 1).map((m) => textOf(m.content)).join("\n");
    const gate = tail.search(/Stop hook/);
    return tail.slice(Math.max(gate, 0)).replace(/\s+/g, " ").slice(0, 400);
  }
  return null;
}

async function stopStage(): Promise<void> {
  ensureNetwork(file);
  mkdirSync(rawDir, { recursive: true });
  const records = readJson<StopRecord[]>("stop", []);
  for (const arm of selected.filter(installed)) {
    if (records.some((r) => r.arm === arm.id)) continue;
    const out = join(runsDir, "stop", arm.id);
    const result = await runSession(file, {
      arm,
      prompt: "Write the plan file, then stop.",
      script: stopScript(arm.id),
      out,
      sessionId: STOP_SESSION_ID,
      projectListing: true,
      timeoutS: 150,
    });
    const expected = stopExpectedRequests(arm.id);
    const lastBody = lastOf(result.recorded)?.body;
    const continuation = continuationAfterDone(result.recorded.map((r) => r.body));
    records.push({
      arm: arm.id,
      requests: result.recorded.length,
      expected_requests: expected,
      forced_continue: continuation !== null,
      plan_written: readText(join(out, "project-listing.tsv")).includes(STOP_PLAN_PATH.split("/").at(-1) as string),
      gate_text: continuation ?? "",
      tool_results: resultTexts(result.recorded[1]?.body).text.slice(0, 300),
    });
    if (lastBody !== undefined) writeFileSync(join(rawDir, `stop-${arm.id}-last.json`), JSON.stringify(lastBody));
    writeJson("stop", records);
    log(`stop ${arm.id}: requests=${result.recorded.length} expected=${expected} forced=${continuation !== null}`);
    rmSync(out, { recursive: true, force: true });
    rmSync(`${out}.access.jsonl`, { force: true });
  }
}

function buildImages(): void {
  const base = baseImage(file);
  run(["docker", "build", "--label", "omca-compare=1", "--build-arg", `CLAUDE_VERSION=${file.claude}`, "-t", base, HERE]);
  for (const arm of file.arms.filter((a) => a.imageVariant !== undefined)) {
    run(["docker", "build", "--label", "omca-compare=1", "-f", join(HERE, `Dockerfile.${arm.imageVariant}`), "--build-arg", `BASE_IMAGE=${base}`, "-t", imageFor(file, arm), HERE]);
  }
}

const readProbe = (name: string): ToolSearchRecord[] =>
  existsSync(join(runsDir, `${name}.jsonl`))
    ? readFileSync(join(runsDir, `${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ToolSearchRecord)
    : [];

function reportStage(): void {
  const raw = {
    date,
    rounds,
    file,
    treeShas: JSON.parse(readFileSync(join(CACHE, "trees.json"), "utf8")) as Record<string, string>,
    install: readJson<Record<string, InstallRecord>>("install", {}),
    firstRun: readJson<Record<string, FirstRunRecord>>("first-run", {}),
    timing: existsSync(join(runsDir, "timing.jsonl"))
      ? readFileSync(join(runsDir, "timing.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TimingRecord)
      : [],
    guards: readJson<GuardRecord[]>("guards", []),
    stop: readJson<StopRecord[]>("stop", []),
    noBun: readJson<NoBunRecord | null>("nobun", null),
    toolSearch: readProbe("toolsearch"),
    keywords: readProbe("keywords"),
    configDirs: Object.fromEntries(file.arms.map((a) => [a.id, templateDir(a.id)])),
  };
  const { results, markdown } = renderMarkdown(raw);
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, `${date}.json`), `${JSON.stringify(results, null, 1)}\n`);
  writeFileSync(join(resultsDir, `${date}.md`), markdown);
  log(`wrote results/${date}.json and results/${date}.md`);
}

function positiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive whole number, got ${raw}`);
  return n;
}

function positiveNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number, got ${raw}`);
  return n;
}

function evalOptions(): EvalOptions {
  const confirm = values["confirm-runs"];
  return {
    file,
    runsDir,
    resultsDir,
    date,
    armIds: values.arm ?? [],
    caseIds: values.case ?? [],
    runsPerCase: positiveInt("runs-per-case", values["runs-per-case"] as string),
    batchSize: positiveInt("batch-size", values["batch-size"] as string),
    model: values.model as string,
    effort: values.effort ?? null,
    maxTurns: positiveInt("max-turns", values["max-turns"] as string),
    budgetUsd: positiveNumber("max-budget-usd", values["max-budget-usd"] as string),
    timeoutS: positiveInt("timeout", values.timeout as string),
    keepRaw: values["keep-raw"] === true,
    real: values.real === true,
    tokenFile: values["token-file"],
    confirmRuns: confirm === undefined ? undefined : positiveInt("confirm-runs", confirm),
    interactive: process.stdin.isTTY === true,
    log,
  };
}

async function evalStage(): Promise<void> {
  if (values.real && values.rehearse) throw new Error("--real and --rehearse exclude each other");
  const options = evalOptions();
  process.exitCode = values.rehearse ? await runRehearsal(options) : await runEval(options);
}

function evalReportStage(): void {
  const options = evalOptions();
  const cases = selectCases(options.caseIds);
  const armIds = file.arms.filter((a) => a.inEval !== false && (options.armIds.length === 0 || options.armIds.includes(a.id))).map((a) => a.id);
  writeEvalReport(options, armIds, cases.map((c) => c.id), date, resultsDir);
}

async function main(): Promise<void> {
  const [command] = positionals;
  const runsStages = command === "all" || (command !== undefined && command !== "eval-report" && command !== "build" && !(command === "eval" && !values.real && !values.rehearse));
  if (runsStages) {
    mkdirSync(runsDir, { recursive: true });
  }
  const stages: Record<string, () => void | Promise<void>> = {
    build: buildImages,
    prepare: () => {
      const shas = existsSync(join(CACHE, "trees.json")) ? (JSON.parse(readFileSync(join(CACHE, "trees.json"), "utf8")) as Record<string, string>) : {};
      for (const arm of selected) {
        const tree = prepareTree(arm);
        if (tree !== null) shas[arm.id] = tree.sha;
        log(`${arm.id}: ${tree === null ? "no tree" : `${tree.sha} -> ${tree.dir}`}`);
      }
      writeFileSync(join(CACHE, "trees.json"), `${JSON.stringify(shas, null, 1)}\n`);
    },
    install: installStage,
    online: onlineStage,
    "first-run": firstRunStage,
    timing: timingStage,
    toolsearch: toolSearchStage,
    keywords: keywordStage,
    nobun: noBunStage,
    guards: guardsStage,
    stop: stopStage,
    report: reportStage,
    eval: evalStage,
    "eval-report": evalReportStage,
  };
  if (command === "all") {
    for (const name of ["prepare", "install", "online", "first-run", "timing", "toolsearch", "keywords", "guards", "stop", "nobun", "report"]) {
      log(`stage ${name}`);
      await stages[name]?.();
    }
  } else if (command !== undefined && stages[command] !== undefined) {
    await stages[command]?.();
  } else {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const leftovers = command === "report" || command === "eval" || command === "eval-report" ? [] : leftoverContainers();
  if (leftovers.length > 0) log(`leftover labelled containers: ${leftovers.join("; ")}`);
}

await main();
