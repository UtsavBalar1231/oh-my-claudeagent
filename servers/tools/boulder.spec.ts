import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Registry } from "../../src/core/boulder.ts";
import { GC_MAX_AGE_SECONDS, gcRegistry, pruneStale, pruneUnbound, tools, unbindBoundSessions } from "./boulder.ts";

const SERVER = join(import.meta.dir, "..", "omca.ts");
const FIXTURES = join(import.meta.dir, "..", "..", "tests", "fixtures", "boulder-schemas");
const COMPLETE = "- [x] 1. one\n- [x] 2. two\n";
const INCOMPLETE = "- [x] 1. one\n- [ ] 2. two\n";
const LONG_AGO = "2020-01-01T00:00:00Z";
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// Each of the 50 writes resolves the project root with a synchronous git spawn, about 110 ms on a Windows
// runner, so the spawns alone outlast the 5 s default and leave 49 writers working in a directory the cleanup removes.
const PARALLEL_WRITERS_TIMEOUT_MS = 60_000;

const roots: string[] = [];
const servers: Bun.Subprocess[] = [];

// A killed process keeps its working directory open on Windows until it has exited, so the directory is removed only after the exit.
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.kill("SIGKILL");
    await server.exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omca-boulder-")));
  roots.push(root);
  expect(Bun.spawnSync(["git", "init", "-q", root], { env: process.env }).exitCode).toBe(0);
  return root;
}

const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.json`), "utf8");
const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;
const registryFile = (root: string) => join(root, ".omca", "state", "boulder.json");
const read = (path: string) => readFileSync(path, "utf8");
const registry = (root: string) => JSON.parse(read(registryFile(root)));
const nowSeconds = () => Math.floor(Date.now() / 1000);

function seedRegistry(root: string, text: string): void {
  mkdirSync(join(root, ".omca", "state"), { recursive: true });
  writeFileSync(registryFile(root), text);
}

function planFile(root: string, name: string, content: string): string {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
}

const call = async (name: string, args: Record<string, unknown>) => {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found.call(args);
};

const write = (root: string, planName: string, sessionId: string, activePlan = "/tmp/plan.md", extra: Record<string, unknown> = {}) =>
  call("boulder_write", { active_plan: activePlan, plan_name: planName, session_id: sessionId, working_directory: root, ...extra });

const progress = (root: string, args: Record<string, unknown>) => call("boulder_progress", { working_directory: root, ...args });

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

describe("boulder_write", () => {
  test("boulder_write creates registry state file", async () => {
    const root = project();
    const before = nowSeconds();
    expect(await write(root, "my-plan", "sess-001")).toBe("Boulder state written: plan=my-plan, sessions=1");
    const { plans, bindings } = registry(root);
    const startedAt = plans["my-plan"].started_at;
    const boundAt = bindings["sess-001"].bound_at;
    expect(startedAt).toMatch(ISO_SECONDS);
    expect(boundAt >= before && boundAt <= nowSeconds()).toBe(true);
    expect(read(registryFile(root))).toBe(
      json({
        plans: { "my-plan": { active_plan: "/tmp/plan.md", started_at: startedAt, session_ids: ["sess-001"] } },
        bindings: { "sess-001": { plan_name: "my-plan", bound_at: boundAt } },
      }),
    );
    expect(read(join(root, ".omca", ".gitignore"))).toBe("*\n!/rules/\n!/rules/**\n");
  });

  test("boulder_write appends sessions and binds both", async () => {
    const root = project();
    await write(root, "my-plan", "sess-001");
    expect(await write(root, "my-plan", "sess-002")).toBe("Boulder state written: plan=my-plan, sessions=2");
    const { plans, bindings } = registry(root);
    expect(plans["my-plan"].session_ids).toEqual(["sess-001", "sess-002"]);
    expect([bindings["sess-001"].plan_name, bindings["sess-002"].plan_name]).toEqual(["my-plan", "my-plan"]);
  });

  test("boulder_write deduplicates sessions", async () => {
    const root = project();
    await write(root, "my-plan", "sess-001");
    expect(await write(root, "my-plan", "sess-001")).toBe("Boulder state written: plan=my-plan, sessions=1");
    expect(registry(root).plans["my-plan"].session_ids).toEqual(["sess-001"]);
  });

  test("boulder_write preserves started_at and drops a stored agent field", async () => {
    const root = project();
    seedRegistry(root, json({ plans: { "my-plan": { active_plan: "/tmp/plan.md", started_at: LONG_AGO, session_ids: [], agent: "x" } }, bindings: {} }));
    await write(root, "my-plan", "sess-002");
    expect(registry(root).plans["my-plan"]).toEqual({
      active_plan: "/tmp/plan.md",
      started_at: LONG_AGO,
      session_ids: ["sess-002"],
    });
  });

  test("boulder_write keeps the stored worktree_path when the call leaves it empty, and ignores a stray agent argument", async () => {
    const root = project();
    await write(root, "wt-plan", "sess-001", "/tmp/plan.md", { agent: "atlas", worktree_path: "/tmp/wt" });
    await write(root, "wt-plan", "sess-002", "/tmp/moved.md");
    expect(registry(root).plans["wt-plan"]).toEqual({
      active_plan: "/tmp/moved.md",
      started_at: expect.stringMatching(ISO_SECONDS),
      session_ids: ["sess-001", "sess-002"],
      worktree_path: "/tmp/wt",
    });
  });

  test("boulder_write two plans distinct bindings", async () => {
    const root = project();
    await write(root, "plan-a", "sess-a", "/tmp/a.md");
    await write(root, "plan-b", "sess-b", "/tmp/b.md");
    const { plans, bindings } = registry(root);
    expect(Object.keys(plans)).toEqual(["plan-a", "plan-b"]);
    expect([bindings["sess-a"].plan_name, bindings["sess-b"].plan_name]).toEqual(["plan-a", "plan-b"]);
  });

  test("boulder_write stores a plan named like an Object.prototype key", async () => {
    const root = project();
    await write(root, "__proto__", "constructor");
    const { plans, bindings } = registry(root);
    expect(Object.hasOwn(plans, "__proto__")).toBe(true);
    expect(bindings.constructor.plan_name).toBe("__proto__");
  });

  test("boulder_write parallel writers no lost updates", async () => {
    const root = project();
    const n = 50;
    await Promise.all(Array.from({ length: n }, (_, i) => write(root, `plan-${i}`, `sess-${i}`, `/tmp/plan-${i}.md`)));
    const { plans, bindings } = registry(root);
    for (let i = 0; i < n; i++) {
      expect(plans[`plan-${i}`].active_plan).toBe(`/tmp/plan-${i}.md`);
      expect(bindings[`sess-${i}`].plan_name).toBe(`plan-${i}`);
    }
    expect([Object.keys(plans).length, Object.keys(bindings).length]).toEqual([n, n]);
  }, PARALLEL_WRITERS_TIMEOUT_MS);

  test("boulder_write rejects arguments that break the schema", async () => {
    const root = project();
    await expect(call("boulder_write", { active_plan: "/tmp/p.md", plan_name: "p", working_directory: root })).rejects.toThrow(
      "boulder_write: session_id must be a string",
    );
    await expect(write(root, "p", "s", "/tmp/p.md", { worktree_path: 3 })).rejects.toThrow("boulder_write: worktree_path must be a string");
    expect(existsSync(registryFile(root))).toBe(false);
  });

  test("the exit unbind removes exactly the bindings boulder_write made in this process", async () => {
    const root = project();
    await write(root, "plan-a", "sess-exit-1");
    await write(root, "plan-b", "sess-exit-2");
    const seeded = registry(root);
    seeded.bindings["sess-elsewhere"] = { plan_name: "plan-a", bound_at: nowSeconds() };
    seedRegistry(root, json(seeded));
    unbindBoundSessions(Date.now() + 1_000);
    expect(Object.keys(registry(root).bindings)).toEqual(["sess-elsewhere"]);
  });
});

describe("session id resolution through the server", () => {
  test("boulder_write session id from env before any hook call", async () => {
    const root = project();
    const callTool = startServer(root, { CLAUDE_CODE_SESSION_ID: "env-sess-001" });
    expect(await callTool("boulder_write", { active_plan: "/tmp/plan.md", plan_name: "env-plan", session_id: "" })).toBe(
      "Boulder state written: plan=env-plan, sessions=1",
    );
    const { plans, bindings } = registry(root);
    expect(plans["env-plan"].session_ids).toEqual(["env-sess-001"]);
    expect(Object.keys(bindings)).toEqual(["env-sess-001"]);
  });

  test("an empty session_id takes the latest hook call's session, not the env value", async () => {
    const root = project();
    const callTool = startServer(root, { CLAUDE_CODE_SESSION_ID: "env-sess-stale" });
    const sessionId = crypto.randomUUID();
    await callTool("omca_hook", { event: "Stop", session_id: sessionId });
    await callTool("boulder_write", { active_plan: planFile(root, "plan.md", INCOMPLETE), plan_name: "hook-plan", session_id: "" });
    expect(Object.keys(registry(root).bindings)).toEqual([sessionId]);
    expect(JSON.parse(await callTool("boulder_progress", {})).plan_path).toBe(join(root, "plan.md"));
  });

  test("with neither a hook nor the env value, boulder_write registers the plan without a binding", async () => {
    const root = project();
    const callTool = startServer(root, {});
    expect(await callTool("boulder_write", { active_plan: "/tmp/plan.md", plan_name: "lone", session_id: "" })).toBe(
      "Boulder state written: plan=lone, sessions=0",
    );
    expect(registry(root).bindings).toEqual({});
  });
});

describe("boulder_progress resolution matches the lenient resolver", () => {
  const missing = (path: string) =>
    JSON.stringify({ error: true, plan_missing: true, plan_path: path, message: `Plan file not found: ${path}.` }, null, 2);

  for (const [name, sessionId, plan] of [
    ["single-plan", "no-such-session", "/home/user/.claude/plans/plan-a.md"],
    ["two-plan", "no-such-session", "/home/user/.claude/plans/plan-b.md"],
  ] as const) {
    test(`the ${name} fixture resolves to ${plan}`, async () => {
      const root = project();
      seedRegistry(root, fixture(name));
      expect(await progress(root, { session_id: sessionId })).toBe(missing(plan));
    });
  }

  test("an explicit binding wins over the most recent plan", async () => {
    const root = project();
    const data = JSON.parse(fixture("two-plan"));
    data.bindings["sess-x"] = { plan_name: "plan-a", bound_at: 1 };
    seedRegistry(root, json(data));
    expect(await progress(root, { session_id: "sess-x" })).toBe(missing("/home/user/.claude/plans/plan-a.md"));
  });

  for (const name of ["corrupt", "half-written"]) {
    test(`a ${name} registry resolves no plan`, async () => {
      const root = project();
      seedRegistry(root, fixture(name));
      expect(await progress(root, { session_id: "any-session" })).toBe("No active plan found in boulder state.");
    });
  }
});

describe("write-path GC", () => {
  test("gc prunes stale unbound complete plan", async () => {
    const root = project();
    const plans = { "stale-complete": { active_plan: planFile(root, "complete.md", COMPLETE), started_at: LONG_AGO, session_ids: ["sess-old"] } };
    seedRegistry(root, json({ plans, bindings: {} }));
    await write(root, "new-plan", "sess-new", "/tmp/new.md");
    expect(Object.keys(registry(root).plans)).toEqual(["new-plan"]);
  });

  test("gc does not prune live bound plan", async () => {
    const root = project();
    const plans = { "old-but-bound": { active_plan: planFile(root, "complete.md", "- [x] 1. Done\n"), started_at: LONG_AGO, session_ids: ["sess-live"] } };
    seedRegistry(root, json({ plans, bindings: { "sess-live": { plan_name: "old-but-bound", bound_at: nowSeconds() } } }));
    await write(root, "new-plan", "sess-new", "/tmp/new.md");
    const after = registry(root);
    expect(Object.keys(after.plans)).toEqual(["old-but-bound", "new-plan"]);
    expect(Object.keys(after.bindings)).toEqual(["sess-live", "sess-new"]);
  });

  test("gc prunes stale binding", async () => {
    const root = project();
    const plans = { "some-plan": { active_plan: "/tmp/some.md", started_at: new Date().toISOString(), session_ids: ["sess-stale"] } };
    seedRegistry(root, json({ plans, bindings: { "sess-stale": { plan_name: "some-plan", bound_at: 1 } } }));
    await write(root, "new-plan", "sess-new", "/tmp/new.md");
    expect(Object.keys(registry(root).bindings)).toEqual(["sess-new"]);
  });

  test("a binding exactly 7 days old is kept and one a second older is pruned", () => {
    const now = 2_000_000_000;
    const reg: Registry = {
      plans: {},
      bindings: { edge: { plan_name: "p", bound_at: now - GC_MAX_AGE_SECONDS }, stale: { plan_name: "p", bound_at: now - GC_MAX_AGE_SECONDS - 1 }, undated: { plan_name: "p" } },
    };
    pruneStale(reg, now);
    expect(Object.keys(reg.bindings)).toEqual(["edge", "undated"]);
  });

  test("only a complete plan file makes a stale unbound plan prunable", () => {
    const root = project();
    const entry = (active_plan: string) => ({ active_plan, started_at: LONG_AGO });
    const reg: Registry = {
      plans: {
        "all-checked": entry(planFile(root, "done.md", COMPLETE)),
        "open-task": entry(planFile(root, "wip.md", INCOMPLETE)),
        "no-checkboxes": entry(planFile(root, "prose.md", "# prose only")),
        "missing-file": entry(join(root, "ghost.md")),
        "empty-path": entry(""),
        "recent-complete": { active_plan: join(root, "done.md"), started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") },
      },
      bindings: {},
    };
    pruneStale(reg, nowSeconds());
    expect(Object.keys(reg.plans)).toEqual(["open-task", "no-checkboxes", "missing-file", "empty-path", "recent-complete"]);
  });

  test("a started_at that is not a UTC second timestamp counts as long ago", () => {
    const root = project();
    const done = planFile(root, "done.md", COMPLETE);
    const reg: Registry = { plans: { dateOnly: { active_plan: done, started_at: new Date().toISOString().slice(0, 10) }, absent: { active_plan: done } }, bindings: {} };
    pruneStale(reg, nowSeconds());
    expect(reg.plans).toEqual({});
  });
});

describe("start-time GC", () => {
  const entry = (path: string) => ({ active_plan: path, started_at: "2026-01-01T00:00:00Z" });

  test("prunes unbound complete plan", () => {
    const root = project();
    const reg: Registry = { plans: { done: entry(planFile(root, "d.md", COMPLETE)) }, bindings: {} };
    expect(pruneUnbound(reg)).toEqual({ pruned_plans: ["done"], pruned_bindings: [] });
    expect(reg.plans).toEqual({});
  });

  test("keeps bound complete plan", () => {
    const root = project();
    const reg: Registry = { plans: { done: entry(planFile(root, "d.md", COMPLETE)) }, bindings: { "sess-1": { plan_name: "done", bound_at: 1 } } };
    expect(pruneUnbound(reg)).toEqual({ pruned_plans: [], pruned_bindings: [] });
    expect(Object.keys(reg.plans)).toEqual(["done"]);
  });

  test("keeps unbound incomplete plan", () => {
    const root = project();
    const reg: Registry = { plans: { wip: entry(planFile(root, "w.md", INCOMPLETE)) }, bindings: {} };
    expect(pruneUnbound(reg)).toEqual({ pruned_plans: [], pruned_bindings: [] });
  });

  test("prunes unbound missing file plan", () => {
    const root = project();
    expect(pruneUnbound({ plans: { ghost: entry(join(root, "gone.md")) }, bindings: {} })).toEqual({ pruned_plans: ["ghost"], pruned_bindings: [] });
  });

  test("prunes plan with empty path", () => {
    expect(pruneUnbound({ plans: { bad: { active_plan: "" }, none: {} }, bindings: {} })).toEqual({ pruned_plans: ["bad", "none"], pruned_bindings: [] });
  });

  test("drops orphan binding then prunes its plan target", () => {
    const root = project();
    const reg: Registry = { plans: { done: entry(planFile(root, "d.md", COMPLETE)) }, bindings: { "sess-x": { plan_name: "no-such-plan", bound_at: 1 } } };
    expect(pruneUnbound(reg)).toEqual({ pruned_plans: ["done"], pruned_bindings: ["sess-x"] });
    expect(reg).toEqual({ plans: {}, bindings: {} });
  });

  test("no boulder file is noop", async () => {
    const root = project();
    expect(await gcRegistry(root)).toEqual({ pruned_plans: [], pruned_bindings: [] });
    expect(readdirSync(root)).toEqual([".git"]);
  });

  test("prunes completed unbound and persists", async () => {
    const root = project();
    seedRegistry(root, JSON.stringify({ plans: { done: entry(planFile(root, "done.md", COMPLETE)) }, bindings: {} }));
    expect(await gcRegistry(root)).toEqual({ pruned_plans: ["done"], pruned_bindings: [] });
    expect(read(registryFile(root))).toBe(json({ plans: {}, bindings: {} }));
  });

  test("bound plan survives", async () => {
    const root = project();
    const text = JSON.stringify({ plans: { done: entry(planFile(root, "done.md", COMPLETE)) }, bindings: { "sess-live": { plan_name: "done", bound_at: 1 } } });
    seedRegistry(root, text);
    expect(await gcRegistry(root)).toEqual({ pruned_plans: [], pruned_bindings: [] });
    expect(read(registryFile(root))).toBe(text);
  });

  test("corrupt boulder is left untouched", async () => {
    const root = project();
    seedRegistry(root, "{corrupt!!!");
    expect(await gcRegistry(root)).toEqual({ pruned_plans: [], pruned_bindings: [] });
    expect(read(registryFile(root))).toBe("{corrupt!!!");
  });

  test("gc result matches pure function", async () => {
    const root = project();
    const data = { plans: { done: entry(planFile(root, "d.md", COMPLETE)), wip: entry(planFile(root, "w.md", INCOMPLETE)) }, bindings: {} };
    seedRegistry(root, JSON.stringify(data));
    const expected = pruneUnbound(structuredClone(data));
    expect(await gcRegistry(root)).toEqual(expected);
    expect(read(registryFile(root))).toBe(json({ plans: { wip: data.plans.wip }, bindings: {} }));
  });
});

describe("boulder_progress", () => {
  const sha256 = (planPath: string) => new Bun.CryptoHasher("sha256").update(readFileSync(planPath)).digest("hex");
  const result = (planPath: string, total: number, completed: number, nextTaskLabel: string | null) =>
    JSON.stringify(
      {
        total,
        completed,
        remaining: total - completed,
        is_complete: total > 0 && completed === total,
        plan_path: planPath,
        plan_sha256: sha256(planPath),
        next_task_label: nextTaskLabel,
      },
      null,
      2,
    );

  test("boulder_progress reads plan checkboxes", async () => {
    const root = project();
    const plan = planFile(root, "plan.md", "# My Plan\n\n- [x] 1. Task one done\n- [ ] 2. Task two pending\n- [ ] 3. Task three pending\n");
    await write(root, "progress-plan", "sess-001", plan);
    expect(await progress(root, { session_id: "sess-001" })).toBe(result(plan, 3, 1, "Task two pending"));
  });

  test("boulder_progress returns the SHA-256 of the plan file's bytes", async () => {
    const root = project();
    const plan = planFile(root, "plan.md", "# Fixture plan\n\n- [x] 1. one\n- [ ] 2. two\n");
    expect(JSON.parse(await progress(root, { plan_path: plan })).plan_sha256).toBe("4fb2594d8a01fe5b99ab89b1b4db02ef0f9784389a895e12334d477d61985c95");
  });

  test("boulder_progress hashes bytes that are not valid UTF-8 as they are on disk", async () => {
    const root = project();
    const plan = join(root, "plan.md");
    writeFileSync(plan, Buffer.from([0x2d, 0x20, 0x5b, 0x20, 0x5d, 0x20, 0x31, 0x2e, 0x20, 0xff, 0x0d, 0x0a]));
    expect(JSON.parse(await progress(root, { plan_path: plan })).plan_sha256).toBe(sha256(plan));
  });

  test("boulder_progress by plan name", async () => {
    const root = project();
    const named = planFile(root, "named.md", "- [x] 1. Done\n- [ ] 2. Pending\n");
    await write(root, "named-plan", "sess-001", named);
    await write(root, "other-plan", "sess-002", planFile(root, "other.md", INCOMPLETE));
    expect(await progress(root, { plan_name: "named-plan", session_id: "sess-002" })).toBe(result(named, 2, 1, "Pending"));
  });

  test("boulder_progress by an unknown plan name skips the resolver", async () => {
    const root = project();
    await write(root, "only-plan", "sess-001", planFile(root, "plan.md", INCOMPLETE));
    expect(await progress(root, { plan_name: "no-such-plan" })).toBe("No active plan found in boulder state.");
  });

  test("boulder_progress exact regex unnumbered ignored", async () => {
    const root = project();
    const plan = planFile(root, "plan.md", "# Plan\n\n- [x] 1. Numbered done\n- [ ] 2. Numbered pending\n- [x] Review docs\n- [ ] Notify stakeholders\n");
    await write(root, "regex-plan", "sess-001", plan);
    expect(await progress(root, { session_id: "sess-001" })).toBe(result(plan, 2, 1, "Numbered pending"));
  });

  test("boulder_progress all complete", async () => {
    const root = project();
    const plan = planFile(root, "plan.md", "- [x] 1. Task one done\n- [x] 2. Task two done\n");
    await write(root, "done-plan", "sess-001", plan);
    expect(await progress(root, { session_id: "sess-001" })).toBe(result(plan, 2, 2, null));
  });

  test("boulder_progress empty plan", async () => {
    const root = project();
    const plan = planFile(root, "plan.md", "# Empty plan\n\nNo tasks here.\n");
    await write(root, "empty-plan", "sess-001", plan);
    expect(await progress(root, { session_id: "sess-001" })).toBe(result(plan, 0, 0, null));
  });

  test("boulder_progress explicit plan path", async () => {
    const root = project();
    const plan = planFile(root, "standalone.md", "- [x] 1. Done\n- [ ] 2. Pending\n");
    expect(await progress(root, { plan_path: plan })).toBe(result(plan, 2, 1, "Pending"));
    expect(existsSync(join(root, ".omca"))).toBe(false);
  });

  test("boulder_progress missing plan returns structured error", async () => {
    const root = project();
    const plan = planFile(root, "plan.md", "- [ ] 1. Task one\n");
    await write(root, "ghost-plan", "sess-001", plan);
    unlinkSync(plan);
    expect(await progress(root, { session_id: "sess-001" })).toBe(
      JSON.stringify({ error: true, plan_missing: true, plan_path: plan, message: `Plan file not found: ${plan}.` }, null, 2),
    );
  });

  test("boulder_progress on a plan path that is a directory is a tool error", async () => {
    const root = project();
    await expect(progress(root, { plan_path: root })).rejects.toThrow("EISDIR");
  });

  test("boulder_progress no active plan returns message", async () => {
    expect(await progress(project(), {})).toBe("No active plan found in boulder state.");
  });

  test("boulder_progress next task label truncated", async () => {
    const root = project();
    const plan = planFile(root, "plan.md", `- [ ] 1. ${"x".repeat(120)}\n`);
    expect(await progress(root, { plan_path: plan })).toBe(result(plan, 1, 0, `${"x".repeat(79)}…`));
  });
});
