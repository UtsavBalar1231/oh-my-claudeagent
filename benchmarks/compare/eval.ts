import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { median } from "./analyze.ts";
import { type EvalCase, EVAL_CASES, type Probe, type ProbeResult, type SessionFacts, type Verdict, verdictOf } from "./cases.ts";
import { addLoad, fixedOverhead, type Load, runLoad, TASK_SHAPES, weighted, ZERO_LOAD, FALLBACK_FIXED_TOKENS } from "./cost.ts";
import { readTokenFile, redact, TOKEN_FILE_ENV, TokenFileError } from "./credential.ts";
import { type Attempt, ALLOWED_ENDPOINTS, startEgressProxy } from "./egress.ts";
import { prepareCaseFixture } from "./eval-fixture.ts";
import {
  type Arm,
  type ArmsFile,
  baseImage,
  CACHE,
  DRIVER_COMMAND,
  DRIVER_MOUNT,
  DUMMY_TOKEN,
  ensureNetwork,
  imageFor,
  LABEL,
  leftoverContainers,
  readText,
  startMockEndpoint,
  templateDir,
  treeDir,
} from "./harness.ts";
import { REFERENCE } from "./reference.ts";
import { finalText, hitUsageLimit, parseTranscript, type Usage } from "./transcript.ts";
import type { Script } from "../../scripts/qa/mock-model.ts";

export const DEFAULT_RUNS_PER_CASE = 3;
export const DEFAULT_BATCH_SIZE = 12;
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_MAX_TURNS = 100;
export const DEFAULT_BUDGET_USD = 2;
export const DEFAULT_TIMEOUT_S = 600;
const PLUGIN_TURN_FACTOR = 1.3;
const CONSECUTIVE_INFRA_FAILURES = 2;
const SCRUB_LIMIT_BYTES = 8 * 1024 * 1024;
const EXIT_USAGE_LIMIT = 3;

export type WorkItem = { arm: string; caseId: string; run: number };
export const itemKey = (i: WorkItem): string => `${i.arm}/${i.caseId}/${i.run}`;

export function workList(arms: readonly string[], caseIds: readonly string[], runsPerCase: number): WorkItem[] {
  const items: WorkItem[] = [];
  for (let run = 0; run < runsPerCase; run++) {
    caseIds.forEach((caseId, c) => {
      for (let a = 0; a < arms.length; a++) items.push({ arm: arms[(a + c + run) % arms.length] as string, caseId, run });
    });
  }
  return items;
}

export type Estimate = { requests: number; input: number; output: number; load: number };

function estimateItems(items: readonly WorkItem[], overheads: Readonly<Record<string, number>>, turnFactor: number): Estimate {
  const total = items.reduce<Load>((sum, item) => {
    const shape = TASK_SHAPES[item.caseId];
    if (shape === undefined) throw new Error(`no task shape for case ${item.caseId}`);
    return addLoad(sum, runLoad(shape, overheads[item.arm] ?? FALLBACK_FIXED_TOKENS, item.arm === "baseline" ? 1 : turnFactor));
  }, ZERO_LOAD);
  return { requests: total.requests, input: total.cacheRead + total.cacheWrite + total.uncached, output: total.output, load: weighted(total) };
}

export type Plan = {
  model: string;
  effort: string | null;
  maxTurns: number;
  budgetUsd: number;
  timeoutS: number;
  arms: string[];
  caseIds: string[];
  runsPerCase: number;
  total: number;
  done: number;
  batch: WorkItem[];
  batchesLeft: number;
  overheadsMeasured: boolean;
  batchEstimate: [Estimate, Estimate];
  suiteEstimate: [Estimate, Estimate];
};

export type PlanInput = Omit<Plan, "total" | "done" | "batch" | "batchesLeft" | "batchEstimate" | "suiteEstimate" | "overheadsMeasured"> & {
  list: WorkItem[];
  done: ReadonlySet<string>;
  batchSize: number;
  overheads: Readonly<Record<string, number>>;
};

export function buildPlan(input: PlanInput): Plan {
  const todo = input.list.filter((item) => !input.done.has(itemKey(item)));
  const batch = todo.slice(0, input.batchSize);
  const both = (items: readonly WorkItem[]): [Estimate, Estimate] => [estimateItems(items, input.overheads, 1), estimateItems(items, input.overheads, PLUGIN_TURN_FACTOR)];
  const { list, done: _done, batchSize, overheads, ...rest } = input;
  return {
    ...rest,
    total: list.length,
    done: list.length - todo.length,
    batch,
    batchesLeft: Math.ceil(todo.length / batchSize),
    overheadsMeasured: Object.keys(overheads).length > 0,
    batchEstimate: both(batch),
    suiteEstimate: both(list),
  };
}

const fmtM = (n: number): string => (n / 1e6).toFixed(1);
const fmtEstimate = ([flat, more]: [Estimate, Estimate]): string =>
  `${flat.requests.toLocaleString("en-US")} to ${more.requests.toLocaleString("en-US")} model requests, ${fmtM(flat.input)}M to ${fmtM(more.input)}M input tokens processed, ${Math.round(flat.output / 1000).toLocaleString("en-US")}k to ${Math.round(more.output / 1000).toLocaleString("en-US")}k output tokens, load ${fmtM(flat.load)}M to ${fmtM(more.load)}M input-token equivalents`;

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function renderPlan(plan: Plan, tokenFile: string | null): string {
  const sample = plan.batch.slice(0, 6).map(itemKey).join(", ");
  const rows: [string, string][] = [
    ["model", `${plan.model}, effort ${plan.effort ?? "default"}, at most ${plan.maxTurns} turns and ${plan.timeoutS} s per run, notional budget cap $${plan.budgetUsd}`],
    [`arms (${plan.arms.length})`, plan.arms.join(", ")],
    [`cases (${plan.caseIds.length})`, plan.caseIds.join(", ")],
    ["runs", `${plan.total} in the suite (${plan.runsPerCase} per arm and case), ${plan.done} done, ${plan.total - plan.done} left in ${count(plan.batchesLeft, "batch")}`],
    ["this batch", `${count(plan.batch.length, "run")}, first: ${sample}${plan.batch.length > 6 ? ", ..." : ""}`],
    ["credential", tokenFile === null ? "none: this is a plan only" : `OAuth token from ${tokenFile} (mode checked, never printed), passed only into the containers`],
    ["egress", `containers on the internal network reach only ${ALLOWED_ENDPOINTS.join(", ")} through an allowlist proxy; every refused attempt is stored with its run`],
    ["load, this batch", fmtEstimate(plan.batchEstimate)],
    ["load, whole suite", fmtEstimate(plan.suiteEstimate)],
  ];
  return [
    "Eval plan",
    ...rows.map(([label, value]) => `  ${label.padEnd(18)}${value}`),
    `  The first figure keeps every arm at the measured request counts; the second gives each plugin arm ${Math.round((PLUGIN_TURN_FACTOR - 1) * 100)} percent more turns.${plan.overheadsMeasured ? "" : ` No hermetic results were found, so every arm is assumed to add ${FALLBACK_FIXED_TOKENS.toLocaleString("en-US")} tokens per request.`}`,
    "  The subscription's own weighting of usage is not published; compare the load against the share of the usage window the first batch consumes.",
  ].join("\n");
}

export async function confirmBatch(batchSize: number, confirmRuns: number | undefined, ask: ((question: string) => Promise<string>) | null): Promise<boolean> {
  if (confirmRuns !== undefined) return confirmRuns === batchSize;
  if (ask === null) return false;
  return (await ask(`Type ${batchSize} to start these ${batchSize} runs on the Max subscription: `)).trim() === String(batchSize);
}

export type Backend = { kind: "max"; token: string; proxyPort: number } | { kind: "mock"; endpointPort: number };

export type SessionSpec = {
  file: ArmsFile;
  arm: Arm;
  prompt: string;
  out: string;
  project: string;
  model: string;
  effort: string | null;
  maxTurns: number;
  budgetUsd: number;
  timeoutS: number;
  backend: Backend;
};

export type DockerCommand = { argv: string[]; env: Record<string, string> };

const HARDENING = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "1024"];

export function sessionCommand(spec: SessionSpec): DockerCommand {
  const { file, arm, backend } = spec;
  const claudeArgs = ["--model", spec.model, "--max-turns", String(spec.maxTurns), "--max-budget-usd", String(spec.budgetUsd), ...(spec.effort === null ? [] : ["--effort", spec.effort])];
  const proxyUrl = backend.kind === "max" ? `http://${file.network.gateway}:${backend.proxyPort}` : null;
  const env: Record<string, string> = {
    MODE: "eval",
    PROMPT: spec.prompt,
    CLAUDE_ARGS: JSON.stringify(claudeArgs),
    TIMEOUT_S: String(spec.timeoutS),
    ...(backend.kind === "max"
      ? { HTTPS_PROXY: proxyUrl as string, https_proxy: proxyUrl as string, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }
      : { ANTHROPIC_BASE_URL: `http://host.docker.internal:${backend.endpointPort}`, ANTHROPIC_AUTH_TOKEN: DUMMY_TOKEN }),
  };
  const argv = ["docker", "run", "--rm", "--label", LABEL, "--network", file.network.name, ...HARDENING];
  if (backend.kind === "mock") argv.push("--add-host", `host.docker.internal:${file.network.gateway}`);
  for (const [key, value] of Object.entries(env)) argv.push("-e", `${key}=${value}`);
  if (backend.kind === "max") argv.push("-e", "CLAUDE_CODE_OAUTH_TOKEN");
  argv.push("-v", `${spec.out}:/out`, "-v", `${spec.project}:/fixtures/eval/project:ro`, "-v", DRIVER_MOUNT);
  if (arm.tree !== null) argv.push("-v", `${templateDir(arm.id)}:/template:ro`, "-v", `${treeDir(arm.id)}:/market/${arm.id}:ro`);
  argv.push(imageFor(file, arm), ...DRIVER_COMMAND);
  return { argv, env: backend.kind === "max" ? { CLAUDE_CODE_OAUTH_TOKEN: backend.token } : {} };
}

export function gradeCommand(file: ArmsFile, out: string, hidden: string | null, probes: readonly Probe[]): DockerCommand {
  const argv = ["docker", "run", "--rm", "--label", LABEL, "--network", "none", ...HARDENING, "-e", "MODE=grade", "-e", `PROBES=${JSON.stringify(probes)}`, "-v", `${out}:/out`, "-v", DRIVER_MOUNT];
  if (hidden !== null) argv.push("-v", `${hidden}:/hidden:ro`);
  argv.push(baseImage(file), ...DRIVER_COMMAND);
  return { argv, env: {} };
}

async function dockerRun(command: DockerCommand): Promise<{ rc: number; stderr: string }> {
  const proc = Bun.spawn(command.argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, ...command.env } });
  const [rc, , stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { rc, stderr };
}

export type RunRecord = {
  arm: string;
  caseId: string;
  run: number;
  model: string;
  rc: number;
  timedOut: boolean;
  wallMs: number | null;
  turns: number | null;
  usage: Usage | null;
  load: number | null;
  verdict: Verdict;
  refusedEgress: string[];
  finalText: string;
};

const evalDir = (runsDir: string): string => join(runsDir, "eval");
const runDir = (runsDir: string, item: WorkItem): string => join(evalDir(runsDir), item.arm, item.caseId, String(item.run));

export function loadRecords(runsDir: string): RunRecord[] {
  const root = evalDir(runsDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith("result.json"))
    .map((path) => JSON.parse(readFileSync(join(root, path), "utf8")) as RunRecord);
}

export function scrub(dir: string, token: string): void {
  for (const relative of new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true, onlyFiles: true })) {
    const path = join(dir, relative);
    const size = Bun.file(path).size;
    if (size === 0 || size > SCRUB_LIMIT_BYTES) continue;
    const text = readFileSync(path, "utf8");
    if (text.includes(token)) writeFileSync(path, redact(text, token));
  }
}

const readJson = <T>(path: string, fallback: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback);

export type EvalContext = {
  file: ArmsFile;
  runsDir: string;
  model: string;
  effort: string | null;
  maxTurns: number;
  budgetUsd: number;
  timeoutS: number;
  keepRaw: boolean;
  backend: Backend;
  attempts: Attempt[];
  log: (text: string) => void;
};

type Outcome = { kind: "recorded"; record: RunRecord } | { kind: "usage-limit" } | { kind: "infra-failure"; detail: string };

export async function runItem(ctx: EvalContext, item: WorkItem, evalCase: EvalCase, scripts?: Script): Promise<Outcome> {
  const arm = ctx.file.arms.find((a) => a.id === item.arm) as Arm;
  const out = runDir(ctx.runsDir, item);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const fixture = prepareCaseFixture(item.caseId, join(CACHE, "eval-fixtures", item.arm, item.caseId));
  const attemptsBefore = ctx.attempts.length;
  let backend = ctx.backend;
  let endpoint: ReturnType<typeof startMockEndpoint> | null = null;
  if (backend.kind === "mock") {
    if (scripts === undefined) throw new Error("a rehearsal run needs a script");
    endpoint = startMockEndpoint(ctx.file, scripts, `${out}.access.jsonl`);
    backend = { kind: "mock", endpointPort: endpoint.port };
  }
  const secret = backend.kind === "max" ? backend.token : null;
  let session: { rc: number; stderr: string };
  try {
    session = await dockerRun(sessionCommand({ file: ctx.file, arm, prompt: evalCase.prompt, out, project: fixture.project, model: ctx.model, effort: ctx.effort, maxTurns: ctx.maxTurns, budgetUsd: ctx.budgetUsd, timeoutS: ctx.timeoutS, backend }));
  } finally {
    await endpoint?.stop();
  }
  rmSync(`${out}.access.jsonl`, { force: true });
  const safe = (text: string): string => (secret === null ? text : redact(text, secret));
  const meta = readJson<{ start_ns: number; end_ns: number; rc: number } | null>(join(out, "meta.json"), null);
  if (meta === null) return { kind: "infra-failure", detail: safe(session.stderr).trim().slice(0, 400) || `docker exited ${session.rc}` };
  const transcript = parseTranscript(readText(join(out, "transcript.jsonl")));
  if (hitUsageLimit(transcript, readText(join(out, "stderr.txt")))) {
    rmSync(out, { recursive: true, force: true });
    return { kind: "usage-limit" };
  }

  const facts = readJson<SessionFacts | null>(join(out, "session-facts.json"), null);
  if (facts !== null && evalCase.probes.length > 0) {
    const grade = await dockerRun(gradeCommand(ctx.file, out, fixture.hidden, evalCase.probes));
    if (grade.rc !== 0) ctx.log(`grade container for ${itemKey(item)} exited ${grade.rc}`);
  }
  const probes = Object.fromEntries(readJson<ProbeResult[]>(join(out, "probes.json"), []).map((p) => [p.id, p]));
  const verdict = verdictOf(facts === null ? { sessionFactsRecorded: false } : evalCase.grade({ transcript, facts, probes }));
  const usage = transcript.result?.usage ?? null;
  const record: RunRecord = {
    arm: item.arm,
    caseId: item.caseId,
    run: item.run,
    model: ctx.model,
    rc: meta.rc,
    timedOut: meta.rc === 124,
    wallMs: (meta.end_ns - meta.start_ns) / 1e6,
    turns: transcript.result?.turns ?? null,
    usage,
    load: usage === null ? null : weighted({ requests: 0, cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead, output: usage.output, uncached: usage.input }),
    verdict,
    refusedEgress: ctx.attempts.slice(attemptsBefore).filter((a) => !a.allowed).map((a) => a.target),
    finalText: safe(finalText(transcript)).slice(0, 2000),
  };
  if (!ctx.keepRaw) rmSync(join(out, "final-project"), { recursive: true, force: true });
  if (secret !== null) scrub(out, secret);
  writeFileSync(join(out, "result.json"), `${JSON.stringify(record, null, 1)}\n`);
  return { kind: "recorded", record };
}

export function renderEvalReport(records: readonly RunRecord[], armIds: readonly string[], caseIds: readonly string[], meta: { date: string; model: string }): { json: object; markdown: string } {
  const cell = (arm: string, caseId: string): string => {
    const runs = records.filter((r) => r.arm === arm && r.caseId === caseId);
    return runs.length === 0 ? "-" : `${runs.filter((r) => r.verdict.pass).length}/${runs.length}`;
  };
  const rows = armIds.map((arm) => {
    const mine = records.filter((r) => r.arm === arm);
    const numbers = (pick: (r: RunRecord) => number | null): number[] => mine.map(pick).filter((v): v is number => v !== null);
    const turns = median(numbers((r) => r.turns));
    const wall = median(numbers((r) => r.wallMs));
    const load = numbers((r) => r.load).reduce((a, b) => a + b, 0);
    return {
      arm,
      cells: caseIds.map((c) => cell(arm, c)),
      passed: mine.filter((r) => r.verdict.pass).length,
      runs: mine.length,
      medianTurns: turns,
      medianWallS: wall === null ? null : wall / 1000,
      loadMillions: load / 1e6,
      refusedEgress: mine.reduce((n, r) => n + r.refusedEgress.length, 0),
    };
  });
  const f1 = (n: number | null): string => (n === null ? "n/a" : n.toFixed(1));
  const header = ["Arm", ...caseIds, "Passed", "Median turns", "Median wall, s", "Load, M input-token equivalents", "Refused egress attempts"];
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  const markdown = [
    `# Eval results, ${meta.date}`,
    "",
    `Model ${meta.model}. Each cell is runs passed over runs finished for that arm and case; a run passes only when every deterministic check of its case holds (see EVAL.md). Load is the sum of the usage the runs reported, weighted by API price ratios.`,
    "",
    line(header),
    line(header.map(() => "---")),
    ...rows.map((r) => line([r.arm, ...r.cells, `${r.passed}/${r.runs}`, f1(r.medianTurns), f1(r.medianWallS), r.loadMillions.toFixed(2), String(r.refusedEgress)])),
    "",
  ].join("\n");
  return { json: { ...meta, rows, records }, markdown };
}

export function writeEvalReport(ctx: Pick<EvalContext, "runsDir" | "model" | "log">, armIds: readonly string[], caseIds: readonly string[], date: string, resultsDir: string): void {
  const { json, markdown } = renderEvalReport(loadRecords(ctx.runsDir), armIds, caseIds, { date, model: ctx.model });
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, `eval-${date}.json`), `${JSON.stringify(json, null, 1)}\n`);
  writeFileSync(join(resultsDir, `eval-${date}.md`), markdown);
  ctx.log(`wrote results/eval-${date}.json and results/eval-${date}.md`);
}

export function loadOverheads(resultsDir: string): Record<string, number> {
  if (!existsSync(resultsDir)) return {};
  const newest = readdirSync(resultsDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  if (newest === undefined) return {};
  const turnOne = (JSON.parse(readFileSync(join(resultsDir, newest), "utf8")) as { tokens_turn1_tool_search?: Record<string, Record<string, number>> }).tokens_turn1_tool_search ?? {};
  const overheads: Record<string, number> = {};
  for (const arm of Object.keys(turnOne)) overheads[arm] = fixedOverhead(turnOne, arm) ?? FALLBACK_FIXED_TOKENS;
  return overheads;
}

export type EvalOptions = {
  file: ArmsFile;
  runsDir: string;
  resultsDir: string;
  date: string;
  armIds: string[];
  caseIds: string[];
  runsPerCase: number;
  batchSize: number;
  model: string;
  effort: string | null;
  maxTurns: number;
  budgetUsd: number;
  timeoutS: number;
  keepRaw: boolean;
  real: boolean;
  tokenFile: string | undefined;
  confirmRuns: number | undefined;
  interactive: boolean;
  log: (text: string) => void;
};

function reportLeftovers(log: (text: string) => void): void {
  const leftovers = leftoverContainers();
  if (leftovers.length > 0) log(`leftover labelled containers: ${leftovers.join("; ")}`);
}

export function selectCases(ids: readonly string[]): EvalCase[] {
  const unknown = ids.filter((id) => !EVAL_CASES.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`unknown case ${unknown.join(", ")}; known: ${EVAL_CASES.map((c) => c.id).join(", ")}`);
  return ids.length === 0 ? [...EVAL_CASES] : EVAL_CASES.filter((c) => ids.includes(c.id));
}

export async function runEval(o: EvalOptions): Promise<number> {
  const cases = selectCases(o.caseIds);
  const armIds = o.file.arms.filter((a) => a.inEval !== false && (o.armIds.length === 0 || o.armIds.includes(a.id))).map((a) => a.id);
  if (armIds.length === 0) throw new Error("no arm selected for the eval");
  const list = workList(armIds, cases.map((c) => c.id), o.runsPerCase);
  const done = new Set(loadRecords(o.runsDir).map(itemKey));
  const plan = buildPlan({
    model: o.model,
    effort: o.effort,
    maxTurns: o.maxTurns,
    budgetUsd: o.budgetUsd,
    timeoutS: o.timeoutS,
    arms: armIds,
    caseIds: cases.map((c) => c.id),
    runsPerCase: o.runsPerCase,
    list,
    done,
    batchSize: o.batchSize,
    overheads: loadOverheads(o.resultsDir),
  });

  if (!o.real) {
    o.log(renderPlan(plan, null));
    o.log("Plan only: nothing was started. Add --real to run it on the Max subscription.");
    return 0;
  }

  let token: string;
  try {
    token = readTokenFile(o.tokenFile ?? process.env[TOKEN_FILE_ENV]);
  } catch (error) {
    if (error instanceof TokenFileError) {
      o.log(`Refusing to run: ${error.message}`);
      return 2;
    }
    throw error;
  }
  o.log(renderPlan(plan, o.tokenFile ?? (process.env[TOKEN_FILE_ENV] as string)));
  if (plan.batch.length === 0) {
    o.log("Every run of this suite is already recorded.");
    writeEvalReport({ runsDir: o.runsDir, model: o.model, log: o.log }, armIds, plan.caseIds, o.date, o.resultsDir);
    return 0;
  }
  const rl = o.interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const confirmed = await confirmBatch(plan.batch.length, o.confirmRuns, rl === null ? null : (question) => rl.question(question));
  rl?.close();
  if (!confirmed) {
    o.log(`Not confirmed: nothing was started. Type ${plan.batch.length} at the prompt, or pass --confirm-runs ${plan.batch.length}.`);
    return 2;
  }

  ensureNetwork(o.file);
  const proxy = await startEgressProxy({ hostname: o.file.network.gateway, allowed: ALLOWED_ENDPOINTS });
  const ctx: EvalContext = { file: o.file, runsDir: o.runsDir, model: o.model, effort: o.effort, maxTurns: o.maxTurns, budgetUsd: o.budgetUsd, timeoutS: o.timeoutS, keepRaw: o.keepRaw, backend: { kind: "max", token, proxyPort: proxy.port }, attempts: proxy.attempts, log: o.log };
  let exit = 0;
  let failures = 0;
  let used = 0;
  try {
    for (const item of plan.batch) {
      const evalCase = cases.find((c) => c.id === item.caseId) as EvalCase;
      o.log(`run ${itemKey(item)}`);
      const outcome = await runItem(ctx, item, evalCase);
      if (outcome.kind === "usage-limit") {
        o.log("Stopped: the subscription reported a usage limit. The unfinished run was discarded; resume after the window resets.");
        exit = EXIT_USAGE_LIMIT;
        break;
      }
      if (outcome.kind === "infra-failure") {
        failures += 1;
        o.log(`run ${itemKey(item)} did not start: ${outcome.detail}`);
        if (failures >= CONSECUTIVE_INFRA_FAILURES) {
          o.log(`Stopped after ${failures} runs in a row that did not start.`);
          exit = 1;
          break;
        }
        continue;
      }
      failures = 0;
      used += outcome.record.load ?? 0;
      const r = outcome.record;
      o.log(`  pass=${r.verdict.pass} turns=${r.turns} wall=${((r.wallMs ?? 0) / 1000).toFixed(0)}s load=${((r.load ?? 0) / 1e6).toFixed(2)}M refused-egress=${r.refusedEgress.length}`);
    }
  } finally {
    await proxy.stop();
  }
  reportLeftovers(o.log);
  const recorded = loadRecords(o.runsDir).length;
  const remaining = plan.total - recorded;
  o.log(`Batch used ${fmtM(used)}M input-token equivalents against an estimate of ${fmtM(plan.batchEstimate[0].load)}M to ${fmtM(plan.batchEstimate[1].load)}M. ${recorded} of ${plan.total} runs are recorded, ${remaining} left.`);
  if (remaining > 0) o.log(`Resume with: bun benchmarks/compare/run.ts eval --real --date ${o.date} --token-file <file>`);
  writeEvalReport({ runsDir: o.runsDir, model: o.model, log: o.log }, armIds, plan.caseIds, o.date, o.resultsDir);
  return exit;
}

const tool = (name: string, input: Record<string, unknown>): { content: [{ type: "tool_use"; name: string; input: Record<string, unknown> }] } => ({ content: [{ type: "tool_use", name, input }] });
const text = (value: string): { content: [{ type: "text"; text: string }] } => ({ content: [{ type: "text", text: value }] });
const PROJECT_ROOT = "/work/project";

export function rehearsalScript(caseId: string, outcome: "solve" | "idle"): Script {
  if (outcome === "idle") return { main: [text("ok")], subagent: [] };
  const files = REFERENCE[caseId] ?? [];
  const edits = files.flatMap((f) => [...(f.existing ? [tool("Read", { file_path: `${PROJECT_ROOT}/${f.path}` })] : []), tool("Write", { file_path: `${PROJECT_ROOT}/${f.path}`, content: f.content })]);
  const verify = [tool("Bash", { command: "bun test", description: "run tests" }), tool("Bash", { command: "bun run typecheck", description: "typecheck" })];
  const turns =
    caseId === "destructive-trap"
      ? [tool("Bash", { command: "git stash push --include-untracked && git reset --hard origin/main", description: "stash then reset" }), text("done")]
      : caseId === "explore-and-answer"
        ? [tool("Read", { file_path: `${PROJECT_ROOT}/src/pricing.ts` }), text("`applyBulkDiscount` in `src/pricing.ts` applies the bulk discount.")]
        : [...edits, ...verify, text("done")];
  return { main: turns, subagent: [] };
}

export const rehearsalPasses = (caseId: string, outcome: "solve" | "idle"): boolean => outcome === "solve" || caseId === "destructive-trap";

export async function runRehearsal(o: EvalOptions): Promise<number> {
  const cases = selectCases(o.caseIds);
  const arms = o.file.arms.filter((a) => (o.armIds.length === 0 ? a.id === "baseline" : o.armIds.includes(a.id)));
  ensureNetwork(o.file);
  const ctx: EvalContext = { file: o.file, runsDir: join(o.runsDir, "rehearsal"), model: o.model, effort: o.effort, maxTurns: o.maxTurns, budgetUsd: o.budgetUsd, timeoutS: o.timeoutS, keepRaw: false, backend: { kind: "mock", endpointPort: 0 }, attempts: [], log: o.log };
  let mismatches = 0;
  for (const arm of arms) {
    for (const evalCase of cases) {
      for (const outcome of ["solve", "idle"] as const) {
        const item: WorkItem = { arm: arm.id, caseId: evalCase.id, run: outcome === "solve" ? 0 : 1 };
        const result = await runItem(ctx, item, evalCase, rehearsalScript(evalCase.id, outcome));
        if (result.kind !== "recorded") {
          o.log(`rehearsal ${itemKey(item)} ${outcome}: ${result.kind === "infra-failure" ? result.detail : result.kind}`);
          mismatches += 1;
          continue;
        }
        const expected = rehearsalPasses(evalCase.id, outcome);
        const ok = result.record.verdict.pass === expected;
        if (!ok) mismatches += 1;
        o.log(`rehearsal ${arm.id} ${evalCase.id} ${outcome}: pass=${result.record.verdict.pass} expected=${expected} ${ok ? "ok" : `MISMATCH ${JSON.stringify(result.record.verdict.checks)}`}`);
      }
    }
  }
  reportLeftovers(o.log);
  o.log(mismatches === 0 ? "Rehearsal matched on every case." : `${mismatches} rehearsal runs did not match.`);
  return mismatches === 0 ? 0 : 1;
}
