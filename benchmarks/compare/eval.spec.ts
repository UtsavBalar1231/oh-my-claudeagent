import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_CASES } from "./cases.ts";
import {
  buildPlan,
  confirmBatch,
  gradeCommand,
  itemKey,
  loadOverheads,
  loadRecords,
  type PlanInput,
  renderEvalReport,
  renderPlan,
  rehearsalPasses,
  rehearsalScript,
  type RunRecord,
  scrub,
  selectCases,
  sessionCommand,
  type SessionSpec,
  workList,
} from "./eval.ts";
import { type Arm, type ArmsFile } from "./harness.ts";
import { REFERENCE } from "./reference.ts";

const POSIX = process.platform !== "win32";
const FAKE_TOKEN = "fake-oauth-token-for-specs";
const FILE: ArmsFile = { claude: "9.9.9", network: { name: "net-x", subnet: "10.9.9.0/24", gateway: "10.9.9.1" }, arms: [] };
const baseline: Arm = { id: "baseline", label: "baseline", tree: null, install: [], details: [] };
const plugin: Arm = { id: "plug", label: "plug", tree: { kind: "local-head", marketplaceName: "m" }, install: [], details: [] };

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "compare-eval-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workList", () => {
  test("goes run by run, case by case, rotating the arm order", () => {
    expect(workList(["a", "b", "c"], ["x", "y"], 2).map(itemKey)).toEqual([
      "a/x/0", "b/x/0", "c/x/0",
      "b/y/0", "c/y/0", "a/y/0",
      "b/x/1", "c/x/1", "a/x/1",
      "c/y/1", "a/y/1", "b/y/1",
    ]);
  });

  test("covers every arm and case once in the first run, so a stopped batch stays balanced", () => {
    const first = workList(["a", "b"], ["x", "y", "z"], 3).slice(0, 6);
    expect(new Set(first.map(itemKey)).size).toBe(6);
    expect(first.every((item) => item.run === 0)).toBe(true);
  });
});

describe("buildPlan", () => {
  const list = workList(["baseline", "plug"], ["bugfix", "explore-and-answer"], 1);
  const input = (over: Partial<PlanInput> = {}): PlanInput => ({
    model: "m",
    effort: null,
    maxTurns: 100,
    budgetUsd: 2,
    timeoutS: 600,
    arms: ["baseline", "plug"],
    caseIds: ["bugfix", "explore-and-answer"],
    runsPerCase: 1,
    list,
    done: new Set(),
    batchSize: 3,
    overheads: { baseline: 1000, plug: 2000 },
    ...over,
  });

  test("takes the first runs that are not done and counts the batches left", () => {
    const plan = buildPlan(input({ done: new Set(["baseline/bugfix/0"]), batchSize: 2 }));
    expect([plan.total, plan.done, plan.batchesLeft]).toEqual([4, 1, 2]);
    expect(plan.batch.map(itemKey)).toEqual(["plug/bugfix/0", "plug/explore-and-answer/0"]);
  });

  test("estimates a batch at the measured request counts and with plugin turns scaled", () => {
    const plan = buildPlan(input({ done: new Set(["baseline/bugfix/0"]), batchSize: 1 }));
    expect(plan.batch.map(itemKey)).toEqual(["plug/bugfix/0"]);
    expect(plan.batchEstimate.map((e) => e.requests)).toEqual([16, 21]);
  });

  test("does not scale the baseline arm", () => {
    const plan = buildPlan(input({ batchSize: 1 }));
    expect(plan.batch.map(itemKey)).toEqual(["baseline/bugfix/0"]);
    expect(plan.batchEstimate.map((e) => e.requests)).toEqual([16, 16]);
  });

  test("says whether the overheads were measured", () => {
    expect(buildPlan(input()).overheadsMeasured).toBe(true);
    expect(buildPlan(input({ overheads: {} })).overheadsMeasured).toBe(false);
  });
});

describe("renderPlan", () => {
  const plan = buildPlan({
    model: "claude-x",
    effort: "high",
    maxTurns: 50,
    budgetUsd: 1.5,
    timeoutS: 300,
    arms: ["baseline"],
    caseIds: ["bugfix"],
    runsPerCase: 2,
    list: workList(["baseline"], ["bugfix"], 2),
    done: new Set(),
    batchSize: 10,
    overheads: { baseline: 1000 },
  });

  test("states the runs, the model, the egress limit and the load", () => {
    const text = renderPlan(plan, null);
    expect(text).toContain("model             claude-x, effort high, at most 50 turns and 300 s per run, notional budget cap $1.5");
    expect(text).toContain("runs              2 in the suite (2 per arm and case), 0 done, 2 left in 1 batch");
    expect(text).toContain("this batch        2 runs, first: baseline/bugfix/0, baseline/bugfix/1");
    expect(text).toContain("reach only api.anthropic.com:443 through an allowlist proxy");
    expect(text).toContain("load, this batch  32 to 32 model requests");
    expect(text).toContain("credential        none: this is a plan only");
  });

  test("names the token file and promises not to print the token", () => {
    expect(renderPlan(plan, "/secure/token")).toContain("OAuth token from /secure/token (mode checked, never printed), passed only into the containers");
  });
});

describe("confirmBatch", () => {
  const answering = (answer: string) => async (question: string): Promise<string> => {
    expect(question).toBe("Type 12 to start these 12 runs on the Max subscription: ");
    return answer;
  };

  test("accepts only the run count, typed or flagged", async () => {
    expect(await confirmBatch(12, undefined, answering("12\n"))).toBe(true);
    expect(await confirmBatch(12, undefined, answering("yes"))).toBe(false);
    expect(await confirmBatch(12, undefined, answering("11"))).toBe(false);
    expect(await confirmBatch(12, 12, null)).toBe(true);
    expect(await confirmBatch(12, 11, answering("12"))).toBe(false);
  });

  test("refuses without a terminal and without the flag", async () => {
    expect(await confirmBatch(12, undefined, null)).toBe(false);
  });
});

describe("sessionCommand", () => {
  const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
    file: FILE,
    arm: baseline,
    prompt: "do it",
    out: "/o",
    project: "/p",
    model: "m",
    effort: "high",
    maxTurns: 7,
    budgetUsd: 1.5,
    timeoutS: 90,
    backend: { kind: "max", token: FAKE_TOKEN, proxyPort: 4321 },
    ...over,
  });

  test("keeps the token out of the argument list and hands it to docker through its environment", () => {
    const { argv, env } = sessionCommand(spec());
    expect(argv.join(" ")).not.toContain(FAKE_TOKEN);
    expect(argv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN });
  });

  test("sends model traffic through the allowlist proxy on the internal network and nowhere else", () => {
    const { argv } = sessionCommand(spec());
    expect(argv.slice(0, 7)).toEqual(["docker", "run", "--rm", "--label", "omca-compare=1", "--network", "net-x"]);
    expect(argv).toContain("HTTPS_PROXY=http://10.9.9.1:4321");
    expect(argv).toContain("https_proxy=http://10.9.9.1:4321");
    expect(argv.some((a) => a.startsWith("ANTHROPIC_"))).toBe(false);
    expect(argv).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
  });

  test("drops capabilities and forbids privilege gain", () => {
    const { argv } = sessionCommand(spec());
    expect(argv.join(" ")).toContain("--cap-drop ALL --security-opt no-new-privileges");
  });

  test("passes the pinned model, limits and effort to claude as one JSON list", () => {
    const { argv } = sessionCommand(spec());
    const args = argv.find((a) => a.startsWith("CLAUDE_ARGS=")) as string;
    expect(JSON.parse(args.slice("CLAUDE_ARGS=".length))).toEqual(["--model", "m", "--max-turns", "7", "--max-budget-usd", "1.5", "--effort", "high"]);
  });

  test("leaves --effort out when none is chosen", () => {
    const { argv } = sessionCommand(spec({ effort: null }));
    expect((argv.find((a) => a.startsWith("CLAUDE_ARGS=")) as string).includes("--effort")).toBe(false);
  });

  test("mounts the project read-only and the plugin template only for a plugin arm", () => {
    const withoutPlugin = sessionCommand(spec()).argv;
    expect(withoutPlugin).toContain("/p:/fixtures/eval/project:ro");
    expect(withoutPlugin.some((a) => a.endsWith(":/template:ro"))).toBe(false);
    const withPlugin = sessionCommand(spec({ arm: plugin })).argv;
    expect(withPlugin.some((a) => a.endsWith(":/template:ro"))).toBe(true);
    expect(withPlugin.some((a) => a.endsWith(":/market/plug:ro"))).toBe(true);
  });

  test("a rehearsal points claude at the mock endpoint and carries no credential", () => {
    const { argv, env } = sessionCommand(spec({ backend: { kind: "mock", endpointPort: 5555 } }));
    expect(env).toEqual({});
    expect(argv).toContain("ANTHROPIC_BASE_URL=http://host.docker.internal:5555");
    expect(argv).toContain("host.docker.internal:10.9.9.1");
    expect(argv.some((a) => a.startsWith("HTTPS_PROXY"))).toBe(false);
    expect(argv).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("runs the image of the claude version in arms.json", () => {
    expect(sessionCommand(spec()).argv).toContain("omca-compare:9.9.9");
    expect(sessionCommand(spec({ arm: { ...baseline, imageVariant: "seed" } })).argv).toContain("omca-compare:9.9.9-seed");
  });
});

describe("gradeCommand", () => {
  const probes = [{ id: "hidden", cmd: ["bun", "test"] }];

  test("runs with no network and no credential, mounting hidden tests read-only", () => {
    const { argv, env } = gradeCommand(FILE, "/o", "/h", probes);
    expect(argv).toContain("none");
    expect(argv.slice(argv.indexOf("--network"), argv.indexOf("--network") + 2)).toEqual(["--network", "none"]);
    expect(argv).toContain("MODE=grade");
    expect(argv).toContain(`PROBES=${JSON.stringify(probes)}`);
    expect(argv).toContain("/h:/hidden:ro");
    expect(env).toEqual({});
    expect(argv.join(" ")).not.toContain("OAUTH");
  });

  test("mounts nothing for a case without a hidden suite", () => {
    expect(gradeCommand(FILE, "/o", null, probes).argv.some((a) => a.endsWith(":/hidden:ro"))).toBe(false);
  });
});

describe("scrub", () => {
  test("rewrites files that hold the token and leaves the rest alone", () => {
    const dir = scratch();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "a.txt"), `line ${FAKE_TOKEN} end\n`);
    writeFileSync(join(dir, "sub", "b.jsonl"), `{"env":"${FAKE_TOKEN}"}\n{"x":1}\n`);
    writeFileSync(join(dir, "clean.txt"), "nothing\n");
    scrub(dir, FAKE_TOKEN);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("line [redacted] end\n");
    expect(readFileSync(join(dir, "sub", "b.jsonl"), "utf8")).toBe('{"env":"[redacted]"}\n{"x":1}\n');
    expect(readFileSync(join(dir, "clean.txt"), "utf8")).toBe("nothing\n");
  });
});

const record = (over: Partial<RunRecord>): RunRecord => ({
  arm: "baseline",
  caseId: "bugfix",
  run: 0,
  model: "m",
  rc: 0,
  timedOut: false,
  wallMs: 10_000,
  turns: 10,
  usage: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
  load: 2_000_000,
  verdict: { pass: true, checks: { a: true } },
  refusedEgress: [],
  finalText: "",
  ...over,
});

describe("records", () => {
  test("loadRecords reads every result.json under the eval directory", () => {
    const runs = scratch();
    for (const [arm, run] of [["baseline", 0], ["plug", 1]] as const) {
      const dir = join(runs, "eval", arm, "bugfix", String(run));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "result.json"), JSON.stringify(record({ arm, run })));
      writeFileSync(join(dir, "transcript.jsonl"), "{}");
    }
    expect(loadRecords(runs).map(itemKey).sort()).toEqual(["baseline/bugfix/0", "plug/bugfix/1"]);
  });

  test("loadRecords finds nothing before the first run", () => {
    expect(loadRecords(scratch())).toEqual([]);
  });
});

describe("loadOverheads", () => {
  test("reads the newest hermetic results and skips eval results", () => {
    const results = scratch();
    const write = (name: string, tokens: object): void => writeFileSync(join(results, name), JSON.stringify({ tokens_turn1_tool_search: tokens }));
    write("2026-10-01.json", { baseline: { system_prompt: 1 } });
    write("2026-10-03.json", { baseline: { system_prompt: 100, conversation: 7 }, omca: { system_prompt: 200, tools_mcp: 50 } });
    write("eval-2026-10-09.json", { baseline: { system_prompt: 999 } });
    expect(loadOverheads(results)).toEqual({ baseline: 100, omca: 250 });
  });

  test("returns nothing when there are no results", () => {
    expect(loadOverheads(join(scratch(), "absent"))).toEqual({});
    expect(loadOverheads(scratch())).toEqual({});
  });
});

describe("renderEvalReport", () => {
  const records = [
    record({ arm: "baseline", caseId: "bugfix", run: 0 }),
    record({ arm: "baseline", caseId: "bugfix", run: 1, verdict: { pass: false, checks: { a: false } }, turns: 20, wallMs: 30_000, load: 4_000_000 }),
    record({ arm: "plug", caseId: "bugfix", run: 0, refusedEgress: ["evil.example:443"] }),
  ];
  const { markdown, json } = renderEvalReport(records, ["baseline", "plug"], ["bugfix", "refactor"], { date: "2026-10-09", model: "m" });

  test("renders passes over runs per arm and case, medians and the load", () => {
    const lines = markdown.split("\n");
    expect(lines).toContain("| Arm | bugfix | refactor | Passed | Median turns | Median wall, s | Load, M input-token equivalents | Refused egress attempts |");
    expect(lines).toContain("| baseline | 1/2 | - | 1/2 | 15.0 | 20.0 | 6.00 | 0 |");
    expect(lines).toContain("| plug | 1/1 | - | 1/1 | 10.0 | 10.0 | 2.00 | 1 |");
  });

  test("keeps the records in the JSON", () => {
    expect((json as { records: unknown[] }).records).toHaveLength(3);
  });
});

describe("rehearsal", () => {
  test("a solving script reads existing files before writing them and verifies afterwards", () => {
    const turns = rehearsalScript("stop-before-verified", "solve").main.flatMap((t) => t.content);
    const names = turns.map((b) => (b.type === "tool_use" ? b.name : "text"));
    expect(names).toEqual(["Read", "Write", "Read", "Write", "Bash", "Bash", "text"]);
  });

  test("a new file is written without a read", () => {
    const names = rehearsalScript("feature-with-tests", "solve").main.flatMap((t) => t.content).map((b) => (b.type === "tool_use" ? b.name : "text"));
    expect(names).toEqual(["Write", "Write", "Bash", "Bash", "text"]);
  });

  test("an idle script only answers", () => {
    expect(rehearsalScript("bugfix", "idle").main).toEqual([{ content: [{ type: "text", text: "ok" }] }]);
  });

  test("every case has a solving script and only the trap passes when idle", () => {
    for (const c of EVAL_CASES) {
      expect(rehearsalScript(c.id, "solve").main.length).toBeGreaterThan(1);
      expect(rehearsalPasses(c.id, "idle")).toBe(c.id === "destructive-trap");
      expect(rehearsalPasses(c.id, "solve")).toBe(true);
    }
    expect(Object.keys(REFERENCE).every((id) => EVAL_CASES.some((c) => c.id === id))).toBe(true);
  });
});

describe("selectCases", () => {
  test("returns every case for no filter and names an unknown id", () => {
    expect(selectCases([]).length).toBe(EVAL_CASES.length);
    expect(selectCases(["refactor"]).map((c) => c.id)).toEqual(["refactor"]);
    expect(() => selectCases(["nope"])).toThrow("unknown case nope");
  });
});

describe.skipIf(!POSIX)("the eval command line", () => {
  const RUN = join(import.meta.dir, "run.ts");
  const setup = (): { cache: string; bin: string; marker: string } => {
    const root = scratch();
    const bin = join(root, "bin");
    const marker = join(root, "docker-called");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`);
    chmodSync(join(bin, "docker"), 0o755);
    return { cache: join(root, "cache"), bin, marker };
  };
  const tokenFile = (mode: number): string => {
    const path = join(scratch(), "token");
    writeFileSync(path, `${FAKE_TOKEN}\n`);
    chmodSync(path, mode);
    return path;
  };
  const exec = (args: string[], fakes: { cache: string; bin: string }) => {
    const r = Bun.spawnSync([process.execPath, RUN, "eval", "--date", "2026-01-01", "--arm", "baseline", "--case", "bugfix", ...args], {
      env: { ...process.env, PATH: `${fakes.bin}:${process.env.PATH ?? ""}`, OMCA_COMPARE_CACHE: fakes.cache, OMCA_COMPARE_TOKEN_FILE: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  };

  test("a plan-only run starts nothing and needs no token", () => {
    const fakes = setup();
    const { code, out } = exec([], fakes);
    expect([code, out.includes("Plan only: nothing was started")]).toEqual([0, true]);
    expect(existsSync(fakes.marker)).toBe(false);
  });

  test("--real refuses a missing token file before any docker call", () => {
    const fakes = setup();
    const missing = join(scratch(), "absent");
    const { code, out } = exec(["--real", "--token-file", missing], fakes);
    expect(code).toBe(2);
    expect(out).toContain(`Refusing to run: token file ${missing} does not exist`);
    expect(existsSync(fakes.marker)).toBe(false);
  });

  test("--real refuses a token file that group or others can read", () => {
    const fakes = setup();
    const { code, out } = exec(["--real", "--token-file", tokenFile(0o644)], fakes);
    expect(code).toBe(2);
    expect(out).toContain("readable by group or others");
    expect(out).not.toContain(FAKE_TOKEN);
    expect(existsSync(fakes.marker)).toBe(false);
  });

  test("--real with no flag and no token file names both ways to give one", () => {
    const fakes = setup();
    const { code, out } = exec(["--real"], fakes);
    expect(code).toBe(2);
    expect(out).toContain("pass --token-file or set OMCA_COMPARE_TOKEN_FILE");
  });

  test("--real prints the plan, then refuses to start without a confirmation", () => {
    const fakes = setup();
    const { code, out } = exec(["--real", "--token-file", tokenFile(0o600)], fakes);
    expect(code).toBe(2);
    expect(out).toContain("this batch        3 runs");
    expect(out).toContain("Not confirmed: nothing was started. Type 3 at the prompt, or pass --confirm-runs 3.");
    expect(out).not.toContain(FAKE_TOKEN);
    expect(existsSync(fakes.marker)).toBe(false);
  });

  test("--confirm-runs must equal the batch size", () => {
    const fakes = setup();
    const { code, out } = exec(["--real", "--token-file", tokenFile(0o600), "--confirm-runs", "2"], fakes);
    expect(code).toBe(2);
    expect(out).toContain("Not confirmed");
    expect(existsSync(fakes.marker)).toBe(false);
  });

  test("--real and --rehearse exclude each other", () => {
    const fakes = setup();
    const { code, out } = exec(["--real", "--rehearse", "--token-file", tokenFile(0o600)], fakes);
    expect(code).not.toBe(0);
    expect(out).toContain("--real and --rehearse exclude each other");
    expect(existsSync(fakes.marker)).toBe(false);
  });
});
