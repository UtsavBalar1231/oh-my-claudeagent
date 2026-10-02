import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_ENTRIES, rotateLedger, SNIPPET_MAX_CHARS, tools } from "./evidence.ts";

const SERVER = join(import.meta.dir, "..", "omca.ts");
const MODULE = join(import.meta.dir, "evidence.ts");
const PLAN_SHA = "deadbeef".repeat(8);
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const roots: string[] = [];
const servers: Bun.Subprocess[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omca-evidence-")));
  roots.push(root);
  expect(Bun.spawnSync(["git", "init", "-q", root], { env: process.env }).exitCode).toBe(0);
  return root;
}

const tool = (name: string) => {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};
const call = async (name: string, args: Record<string, unknown>) => tool(name).call(args);

const ledgerFile = (root: string) => join(root, ".omca", "evidence", "verification-evidence.json");
const archiveFile = (root: string, month: string) => join(root, ".omca", "evidence", `verification-evidence.${month}.json`);
const read = (path: string) => readFileSync(path, "utf8");
const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;
const entries = (root: string) => JSON.parse(read(ledgerFile(root))).entries;

const log = (root: string, extra: Record<string, unknown> = {}) =>
  call("evidence_log", {
    evidence_type: "test",
    command: "just test",
    exit_code: 0,
    output_snippet: "5 passed",
    working_directory: root,
    ...extra,
  });

const entry = (i: number) => ({
  type: "test",
  command: `cmd-${i}`,
  exit_code: 0,
  output_snippet: "ok",
  timestamp: "2026-10-02T00:00:00Z",
});

function seedLedger(root: string, count: number, make = entry): object[] {
  const seeded = Array.from({ length: count }, (_, i) => make(i));
  mkdirSync(join(root, ".omca", "evidence"), { recursive: true });
  writeFileSync(ledgerFile(root), json({ entries: seeded }));
  return seeded;
}

function startServer(project: string, env: Record<string, string>) {
  const childEnv = { ...process.env, ...env };
  if (!("CLAUDE_CODE_SESSION_ID" in env)) delete childEnv.CLAUDE_CODE_SESSION_ID;
  const proc = Bun.spawn([process.execPath, SERVER], { cwd: project, env: childEnv, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  servers.push(proc);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id = 0;
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })}\n`);
    proc.stdin.flush();
    while (!buffer.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the server closed stdout");
      buffer += decoder.decode(value, { stream: true });
    }
    const line = buffer.slice(0, buffer.indexOf("\n"));
    buffer = buffer.slice(line.length + 1);
    return JSON.parse(line).result.content[0].text;
  };
}

describe("evidence_log", () => {
  test("evidence_log creates file: one entry, exact text and ledger", async () => {
    const root = project();
    const before = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    expect(await log(root)).toBe("Evidence recorded: test (exit 0), 1 total entries");
    const after = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const [{ timestamp }] = entries(root);
    expect(timestamp).toMatch(ISO_SECONDS);
    expect(timestamp >= before && timestamp <= after).toBe(true);
    expect(read(ledgerFile(root))).toBe(
      json({ entries: [{ type: "test", command: "just test", exit_code: 0, output_snippet: "5 passed", timestamp }] }),
    );
  });

  test("evidence_log appends entries in order", async () => {
    const root = project();
    await log(root, { evidence_type: "build", command: "just build", output_snippet: "build success" });
    expect(await log(root, { evidence_type: "lint", command: "just lint", exit_code: 2 })).toBe(
      "Evidence recorded: lint (exit 2), 2 total entries",
    );
    expect(entries(root).map((e: { type: string; exit_code: number }) => [e.type, e.exit_code])).toEqual([
      ["build", 0],
      ["lint", 2],
    ]);
  });

  test("evidence_log truncates snippet at 2,000 characters", async () => {
    const root = project();
    await log(root, { exit_code: 1, output_snippet: "x".repeat(5000) });
    await log(root, { output_snippet: "😀".repeat(3000) });
    const [ascii, astral] = entries(root);
    expect(ascii.output_snippet).toBe("x".repeat(SNIPPET_MAX_CHARS));
    expect(astral.output_snippet).toBe("😀".repeat(SNIPPET_MAX_CHARS));
  });

  test("evidence_log keeps verified_by when given and omits it when empty", async () => {
    const root = project();
    await log(root, { verified_by: "executor" });
    await log(root, { verified_by: "" });
    const [given, empty] = entries(root);
    expect(given.verified_by).toBe("executor");
    expect(Object.keys(empty)).toEqual(["type", "command", "exit_code", "output_snippet", "timestamp"]);
  });

  test("evidence_log with plan_sha256 stores it after verified_by", async () => {
    const root = project();
    await log(root, { evidence_type: "final_verification", verified_by: "sisyphus", plan_sha256: PLAN_SHA });
    const [stored] = entries(root);
    expect(Object.keys(stored)).toEqual(["type", "command", "exit_code", "output_snippet", "timestamp", "verified_by", "plan_sha256"]);
    expect(stored.plan_sha256).toBe(PLAN_SHA);
  });

  test("evidence_log without plan_sha256, or with an empty one, omits the key", async () => {
    const root = project();
    await log(root, { output_snippet: `plan_sha256:${PLAN_SHA}` });
    await log(root, { plan_sha256: "" });
    expect(entries(root).map((e: object) => "plan_sha256" in e)).toEqual([false, false]);
  });

  test("evidence_log leaves only the ledger in .omca/evidence", async () => {
    const root = project();
    await log(root);
    expect(readdirSync(join(root, ".omca", "evidence")).sort()).toEqual(["verification-evidence.json"]);
  });

  test("evidence_log resolves a subdirectory to the git root", async () => {
    const root = project();
    mkdirSync(join(root, "pkg", "src"), { recursive: true });
    await log(join(root, "pkg", "src"));
    expect(entries(root)).toHaveLength(1);
    expect(existsSync(join(root, "pkg", "src", ".omca"))).toBe(false);
  });

  test("evidence_log refuses a ledger that does not parse and leaves it untouched", async () => {
    const root = project();
    mkdirSync(join(root, ".omca", "evidence"), { recursive: true });
    writeFileSync(ledgerFile(root), "{corrupt");
    await expect(log(root)).rejects.toThrow(
      `${ledgerFile(root)} is not an evidence ledger ({"entries": [...]}); move it aside to keep logging evidence`,
    );
    expect(read(ledgerFile(root))).toBe("{corrupt");
  });

  test("evidence_log keeps other top-level ledger keys", async () => {
    const root = project();
    mkdirSync(join(root, ".omca", "evidence"), { recursive: true });
    writeFileSync(ledgerFile(root), json({ note: "kept", entries: [] }));
    await log(root);
    expect(Object.keys(JSON.parse(read(ledgerFile(root))))).toEqual(["note", "entries"]);
  });

  test("evidence_log rejects arguments that break the schema", async () => {
    const root = project();
    await expect(log(root, { evidence_type: "deploy" })).rejects.toThrow(
      "evidence_log: evidence_type must be one of build, test, lint, manual, final_verification",
    );
    await expect(log(root, { exit_code: 1.5 })).rejects.toThrow("evidence_log: exit_code must be an integer");
    await expect(log(root, { exit_code: "0" })).rejects.toThrow("evidence_log: exit_code must be an integer");
    await expect(log(root, { command: undefined })).rejects.toThrow("evidence_log: command must be a string");
    await expect(log(root, { verified_by: null })).rejects.toThrow("evidence_log: verified_by must be a string");
    expect(existsSync(ledgerFile(root))).toBe(false);
  });

  test("evidence_log parallel writers lose no entries", async () => {
    const root = project();
    const n = 30;
    await Promise.all(Array.from({ length: n }, (_, i) => log(root, { command: `cmd-${i}` })));
    const commands = entries(root).map((e: { command: string }) => e.command);
    expect(commands.sort()).toEqual(Array.from({ length: n }, (_, i) => `cmd-${i}`).sort());
  });

  test("evidence_log from 8 concurrent processes loses no entry", async () => {
    const root = project();
    const perProcess = 20;
    const script = [
      `const { tools } = await import(${JSON.stringify(MODULE)});`,
      `const log = tools.find((t) => t.name === "evidence_log");`,
      `for (let i = 0; i < ${perProcess}; i++) {`,
      `  await log.call({ evidence_type: "test", command: process.env.WORKER + "-" + i, exit_code: 0, output_snippet: "ok", working_directory: process.env.ROOT });`,
      `}`,
    ].join("\n");
    const workers = Array.from({ length: 8 }, (_, w) =>
      Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, WORKER: `w${w}`, ROOT: root }, stderr: "pipe" }),
    );
    expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual(Array(8).fill(0));
    const expected = workers.flatMap((_, w) => Array.from({ length: perProcess }, (_, i) => `w${w}-${i}`));
    expect(entries(root).map((e: { command: string }) => e.command).sort()).toEqual(expected.sort());
    expect(readdirSync(join(root, ".omca", "evidence"))).toEqual(["verification-evidence.json"]);
  });
});

describe("evidence_read", () => {
  test("evidence_read returns entries as the exact JSON text", async () => {
    const root = project();
    await log(root, { command: "just test", output_snippet: "all good" });
    expect(await call("evidence_read", { working_directory: root })).toBe(JSON.stringify({ entries: entries(root) }, null, 2));
  });

  test("evidence_read handles missing file", async () => {
    expect(await call("evidence_read", { working_directory: project() })).toBe("No verification evidence recorded.");
  });

  test("evidence_read treats a corrupt or empty ledger as no evidence", async () => {
    const root = project();
    mkdirSync(join(root, ".omca", "evidence"), { recursive: true });
    for (const text of ["{corrupt", "[]", "null", json({ entries: [] })]) {
      writeFileSync(ledgerFile(root), text);
      expect(await call("evidence_read", { working_directory: root })).toBe("No verification evidence recorded.");
    }
  });
});

describe("ledger rotation", () => {
  const OCTOBER = new Date("2026-10-15T12:00:00Z");

  test("a 1,200-entry ledger keeps the newest 500 live and moves 700 to the month archive", async () => {
    const root = project();
    const seeded = seedLedger(root, 1200);
    expect(await rotateLedger(root, OCTOBER)).toBe(700);
    expect(read(ledgerFile(root))).toBe(json({ entries: seeded.slice(700) }));
    expect(read(archiveFile(root, "202610"))).toBe(json({ entries: seeded.slice(0, 700) }));
    expect(readdirSync(join(root, ".omca", "evidence")).sort()).toEqual([
      "verification-evidence.202610.json",
      "verification-evidence.json",
    ]);
  });

  test("rotation appends to the month's existing archive", async () => {
    const root = project();
    const seeded = seedLedger(root, 1001);
    const earlier = [entry(-2), entry(-1)];
    writeFileSync(archiveFile(root, "202610"), json({ entries: earlier }));
    expect(await rotateLedger(root, OCTOBER)).toBe(501);
    expect(read(archiveFile(root, "202610"))).toBe(json({ entries: [...earlier, ...seeded.slice(0, 501)] }));
    expect(entries(root)).toHaveLength(KEEP_ENTRIES);
  });

  test("a ledger over 1 MiB rotates even under 1,000 entries", async () => {
    const root = project();
    const seeded = seedLedger(root, 600, (i) => ({ ...entry(i), output_snippet: "y".repeat(2000) }));
    expect(readFileSync(ledgerFile(root)).byteLength).toBeGreaterThan(1024 * 1024);
    expect(await rotateLedger(root, OCTOBER)).toBe(100);
    expect(read(ledgerFile(root))).toBe(json({ entries: seeded.slice(100) }));
  });

  test("a ledger at 1,000 entries and under 1 MiB is left byte-identical", async () => {
    const root = project();
    seedLedger(root, 1000);
    const before = read(ledgerFile(root));
    expect(await rotateLedger(root, OCTOBER)).toBe(0);
    expect(read(ledgerFile(root))).toBe(before);
    expect(existsSync(archiveFile(root, "202610"))).toBe(false);
  });

  test("a missing ledger rotates nothing and creates no ledger", async () => {
    const root = project();
    expect(await rotateLedger(root, OCTOBER)).toBe(0);
    expect(readdirSync(join(root, ".omca", "evidence"))).toEqual([]);
  });

  test("the archive month is taken in UTC", async () => {
    const root = project();
    seedLedger(root, 1001);
    expect(await rotateLedger(root, new Date("2026-10-31T23:30:00-05:00"))).toBe(501);
    expect(existsSync(archiveFile(root, "202611"))).toBe(true);
  });
});

describe("through the server", () => {
  const testEvidence = { evidence_type: "test", command: "just test", exit_code: 0, output_snippet: "ok" };

  test("evidence_log before any hook call writes no status file", async () => {
    const root = project();
    const callTool = startServer(root, {});
    expect(await callTool("evidence_log", testEvidence)).toBe("Evidence recorded: test (exit 0), 1 total entries");
    expect(existsSync(join(root, ".omca", "state", "session"))).toBe(false);
  });

  test("evidence_log updates the status file of the latest hook session", async () => {
    const root = project();
    const callTool = startServer(root, {});
    const sessionId = crypto.randomUUID();
    const statusFile = join(root, ".omca", "state", "session", `${sessionId}.json`);
    const hook = { event: "PostToolUse", session_id: sessionId, tool_name: "Bash", tool_input: JSON.stringify({ command: "just test" }) };
    expect(await callTool("omca_hook", hook)).toContain("PostToolUse");
    const recorded = JSON.parse(read(statusFile));
    expect(recorded.verification).toEqual({ command: "just test", at: recorded.last_hook_at, exit_code: null, evidence_logged: false });

    const before = Math.floor(Date.now() / 1000);
    expect(await callTool("evidence_log", testEvidence)).toBe("Evidence recorded: test (exit 0), 1 total entries");
    const after = Math.floor(Date.now() / 1000);
    const updated = JSON.parse(read(statusFile));
    expect(updated.last_hook_at >= before && updated.last_hook_at <= after).toBe(true);
    expect(read(statusFile)).toBe(
      `${JSON.stringify({
        session_id: sessionId,
        last_hook_at: updated.last_hook_at,
        verification: { ...recorded.verification, evidence_logged: true },
      })}\n`,
    );
  });
});
