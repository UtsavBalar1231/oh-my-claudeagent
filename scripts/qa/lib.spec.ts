import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AccessEntry, childEnv, claudeBin, createChecks, createScratch, localhostOnly, parseJsonLines, readJsonLines, type TraceEntry, traceCount, watchDrift } from "./lib.ts";

let lines: string[] = [];
const print = (line: string): void => void lines.push(line);

beforeEach(() => {
  lines = [];
});

describe("createChecks", () => {
  test("prints PASS and FAIL lines and counts each", () => {
    const checks = createChecks(print);

    checks.pass("one");
    checks.fail("two");
    checks.check(true, "three", "not three");
    checks.check(false, "not four", "four");

    expect(lines).toEqual(["[qa] PASS: one", "[qa] FAIL: two", "[qa] PASS: three", "[qa] FAIL: four"]);
    expect(checks.counts).toEqual({ passed: 2, failed: 2 });
  });

  test("summary prints the tally and reports whether nothing failed", () => {
    const clean = createChecks(print);
    clean.pass("a");
    expect(clean.summary("probe")).toBe(true);

    const failing = createChecks(print);
    failing.fail("b");
    expect(failing.summary("probe")).toBe(false);

    expect(lines).toEqual(["[qa] PASS: a", "[qa] probe: 1 passed, 0 failed", "[qa] FAIL: b", "[qa] probe: 0 passed, 1 failed"]);
  });

  test("summary is false when no check ran", () => {
    expect(createChecks(print).summary("probe")).toBe(false);
    expect(lines).toEqual(["[qa] probe: 0 passed, 0 failed"]);
  });
});

describe("createScratch", () => {
  const keep = process.env.QA_KEEP_SCRATCH;

  afterEach(() => {
    if (keep === undefined) delete process.env.QA_KEEP_SCRATCH;
    else process.env.QA_KEEP_SCRATCH = keep;
  });

  test("dir creates a unique directory under the temp dir and cleanup removes each with a receipt", () => {
    const scratch = createScratch(print);
    const a = scratch.dir("a");
    const b = scratch.dir("a");

    expect(a).not.toBe(b);
    expect(a.startsWith(join(tmpdir(), "omca-qa-a-"))).toBe(true);
    expect(existsSync(a) && existsSync(b)).toBe(true);

    scratch.cleanup();

    expect(existsSync(a) || existsSync(b)).toBe(false);
    expect(lines).toEqual([`removed: ${a}`, `removed: ${b}`]);
  });

  test("project is a git repository with a committer identity", () => {
    const scratch = createScratch(print);
    const project = scratch.project();
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", project, ...args], { env: process.env, stdout: "pipe" }).stdout.toString().trim();

    expect(git("rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(git("config", "user.email")).toBe("qa@example.invalid");
    expect(git("config", "user.name")).toBe("qa harness");

    scratch.cleanup();
  });

  test("plugin is the packaged tree: it ships the template and omits the QA harness", () => {
    const scratch = createScratch(print);
    const plugin = scratch.plugin();

    expect(existsSync(join(plugin, "templates", "claudemd.md"))).toBe(true);
    expect(existsSync(join(plugin, "scripts", "qa"))).toBe(false);

    scratch.cleanup();
  });

  test("QA_KEEP_SCRATCH=1 keeps the directories and says so", () => {
    process.env.QA_KEEP_SCRATCH = "1";
    const scratch = createScratch(print);
    const dir = scratch.dir("kept");

    scratch.cleanup();

    expect(existsSync(dir)).toBe(true);
    expect(lines).toEqual([`kept (QA_KEEP_SCRATCH=1): ${dir}`]);
    rmSync(dir, { recursive: true });
  });
});

describe("watchDrift", () => {
  let home = "";
  const settings = () => join(home, ".claude", "settings.json");
  const claudeJson = () => join(home, ".claude.json");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omca-drift-spec-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(settings(), '{"a":1}\n');
    writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { id: 1 }, counter: 1 }));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("reports nothing while both files are untouched", () => {
    expect(watchDrift(home).changed()).toEqual([]);
  });

  test("reports the settings file when any byte changes", () => {
    const drift = watchDrift(home);

    writeFileSync(settings(), '{"a":2}\n');

    expect(drift.changed()).toEqual([settings()]);
  });

  test("ignores ~/.claude.json churn outside oauthAccount and reports a changed sign-in", () => {
    const drift = watchDrift(home);

    writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { id: 1 }, counter: 2 }));
    expect(drift.changed()).toEqual([]);

    writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { id: 2 }, counter: 2 }));
    expect(drift.changed()).toEqual([claudeJson()]);
  });

  test("treats a file that appears or disappears as a change", () => {
    const drift = watchDrift(home);

    rmSync(settings());
    expect(drift.changed()).toEqual([settings()]);

    const empty = mkdtempSync(join(tmpdir(), "omca-drift-spec-"));
    const fromAbsent = watchDrift(empty);
    mkdirSync(join(empty, ".claude"));
    writeFileSync(join(empty, ".claude", "settings.json"), "{}");
    expect(fromAbsent.changed()).toEqual([join(empty, ".claude", "settings.json")]);
    rmSync(empty, { recursive: true });
  });
});

describe("childEnv", () => {
  const KEYS = ["CLAUDE_CODE_SESSION_ID", "ANTHROPIC_BASE_URL", "OMCA_DISABLED_HOOKS", "QA_SPEC_KEEP"];
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("drops inherited CLAUDE, ANTHROPIC and OMCA variables, keeps the rest, and applies the extras last", () => {
    for (const key of KEYS) saved.set(key, process.env[key]);
    process.env.CLAUDE_CODE_SESSION_ID = "outer";
    process.env.ANTHROPIC_BASE_URL = "http://outer";
    process.env.OMCA_DISABLED_HOOKS = "all";
    process.env.QA_SPEC_KEEP = "kept";

    const env = childEnv({ ANTHROPIC_BASE_URL: "http://inner", EXTRA: "1" });

    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.OMCA_DISABLED_HOOKS).toBeUndefined();
    expect(env.QA_SPEC_KEEP).toBe("kept");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://inner");
    expect(env.EXTRA).toBe("1");
  });
});

describe("log helpers", () => {
  test("parseJsonLines skips blank lines and parses each object", () => {
    expect(parseJsonLines<{ n: number }>('{"n":1}\n\n  \n{"n":2}\n')).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("traceCount counts an event, optionally for one tool", () => {
    const trace: TraceEntry[] = [
      { event: "PostToolUse", tool_name: "Bash", output: "empty" },
      { event: "PostToolUse", tool_name: "Write", output: "context" },
      { event: "Stop", output: "empty" },
    ];

    expect(traceCount(trace, "PostToolUse")).toBe(2);
    expect(traceCount(trace, "PostToolUse", "Bash")).toBe(1);
    expect(traceCount(trace, "Stop", "Bash")).toBe(0);
  });

  test("localhostOnly needs at least one entry and no foreign client", () => {
    const entry = (client: string): AccessEntry => ({ client, path: "/v1/messages", queue: "main", turn: 0, tool_results: 0 });

    expect(localhostOnly([])).toBe(false);
    expect(localhostOnly([entry("127.0.0.1"), entry("127.0.0.1")])).toBe(true);
    expect(localhostOnly([entry("127.0.0.1"), entry("10.0.0.2")])).toBe(false);
  });

  test("readJsonLines reads a file and treats a missing file as no entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "omca-lib-spec-"));
    writeFileSync(join(dir, "t.jsonl"), '{"event":"Stop","output":"empty"}\n');

    expect(readJsonLines<TraceEntry>(join(dir, "t.jsonl"))).toEqual([{ event: "Stop", output: "empty" }]);
    expect(readJsonLines(join(dir, "missing.jsonl"))).toEqual([]);
    rmSync(dir, { recursive: true });
  });
});

describe("claudeBin", () => {
  const saved = process.env.QA_CLAUDE_BIN;

  afterEach(() => {
    if (saved === undefined) delete process.env.QA_CLAUDE_BIN;
    else process.env.QA_CLAUDE_BIN = saved;
  });

  test("resolves QA_CLAUDE_BIN on PATH, keeps a name PATH does not know, and defaults to claude", () => {
    process.env.QA_CLAUDE_BIN = "bun";
    expect(claudeBin()).toBe(Bun.which("bun") ?? "");
    process.env.QA_CLAUDE_BIN = "omca-no-such-claude";
    expect(claudeBin()).toBe("omca-no-such-claude");
    delete process.env.QA_CLAUDE_BIN;
    expect(claudeBin()).toBe(Bun.which("claude") ?? "claude");
  });
});

describe("the QA scripts share one child environment and one claude runner", () => {
  test("no script outside lib.ts defines its own childEnv or runClaude", () => {
    const scripts = join(import.meta.dir, "..");
    const files = [...new Bun.Glob("qa/*.ts").scanSync(scripts), "bench.ts"].filter((file) => !file.endsWith(".spec.ts") && file !== "qa/lib.ts");
    const offenders = files.filter((file) => /^(?:async )?function (?:childEnv|runClaude)\b/m.test(readFileSync(join(scripts, file), "utf8"))).sort();
    expect(offenders).toEqual([]);
  });
});
