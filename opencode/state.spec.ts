import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gcRegistry, tools as legacyTools, unbindBoundSessions } from "../servers/tools/boulder.ts";
import { bindPlan, boundPlan, PLAN_FILE_BYTE_LIMIT, PLAN_TASK_LIMIT, readBoundPlan, readSnapshot, STATE_FILE_BYTE_LIMIT, unbindPlan } from "./state.ts";

let directory: string;
let checkout: string;
const FINAL = "# Work\n\n**Status**: FINAL\n\n- [ ] 1. First task\n- [x] 2. Second task\n  - Depends on: 1\n";

function put(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const plan = (name = "work", source = FINAL): string => put(join(checkout, `${name}.md`), source);
const statePath = (name: string): string => join(checkout, ".omca", "state", name);
const registryPath = (): string => statePath("boulder.json");
const readRegistry = (): Record<string, any> => JSON.parse(readFileSync(registryPath(), "utf8"));
const registry = (data: unknown): void => { put(registryPath(), JSON.stringify(data)); };
const ledgerPath = (): string => join(checkout, ".omca", "evidence", "verification-evidence.json");
const ledger = (entries: unknown[]): void => { put(ledgerPath(), JSON.stringify({ version: 1, entries })); };
const evidence = (hash: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "final_verification", command: "bun test", exit_code: 0, timestamp: "2026-10-15T10:00:00Z", output_snippet: "Passed", plan_sha256: hash, ...overrides,
});

beforeEach(() => {
  const preferred = join(homedir(), ".cache", "tmp", "opencode");
  directory = mkdtempSync(join(existsSync(preferred) ? preferred : tmpdir(), "omca-state-"));
  checkout = join(directory, "checkout");
  mkdirSync(checkout);
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe("native session snapshots", () => {
  test("missing state is observable and snapshots never create .omca", async () => {
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.plan).toBeNull();
    expect(snapshot.evidence.verdict).toBe("missing");
    expect(snapshot.health).toContainEqual({ name: "registry", state: "warning", detail: "Registry is missing" });
    expect(snapshot.health).toContainEqual({ name: "ledger", state: "warning", detail: "Evidence ledger is missing" });
    expect(existsSync(join(checkout, ".omca"))).toBe(false);
    await unbindPlan(checkout, "ses_one");
    expect(existsSync(join(checkout, ".omca"))).toBe(false);
  });

  test("resolves only the exact prefixed session binding, never sole/latest/raw bindings", async () => {
    const one = plan("one");
    const two = plan("two");
    registry({ plans: { legacy: { active_plan: one, started_at: "2099-01-01" } }, bindings: { ses_three: { plan_name: "legacy" } } });
    expect(boundPlan(checkout, "ses_one")).toBeNull();
    expect(boundPlan(checkout, "ses_three")).toBeNull();
    await bindPlan(checkout, "ses_one", one);
    await bindPlan(checkout, "ses_two", two);
    expect(readSnapshot(checkout, "ses_one").plan?.name).toBe("one");
    expect(readSnapshot(checkout, "ses_two").plan?.name).toBe("two");
    expect(readSnapshot(checkout, "ses_three").plan).toBeNull();
    expect(Object.keys(readRegistry().bindings).sort()).toEqual(["opencode:ses_one", "opencode:ses_two", "ses_three"]);
    expect(readRegistry().plans.one.session_ids).toEqual(["opencode:ses_one"]);
    await unbindPlan(checkout, "ses_one");
    expect(boundPlan(checkout, "ses_one")).toBeNull();
    expect(boundPlan(checkout, "ses_two")?.path).toBe(two);
    expect(readRegistry().bindings.ses_three).toEqual({ plan_name: "legacy" });
  });

  test("preserves unknown registry, plan, and binding metadata on bind and explicit pause", async () => {
    const path = plan();
    registry({ version: 1, custom: { retained: true }, plans: { work: { active_plan: path, started_at: "old", session_ids: ["claude_session"], worktree_path: "/existing", metadata: 123 } }, bindings: { "opencode:ses_one": { plan_name: "work", extra: "keep" }, other: { plan_name: "work" } } });
    await bindPlan(checkout, "ses_one", path);
    const saved = readRegistry();
    expect(saved.custom).toEqual({ retained: true });
    expect(saved.plans.work).toMatchObject({ started_at: "old", worktree_path: "/existing", metadata: 123, session_ids: ["claude_session", "opencode:ses_one"] });
    expect(saved.bindings["opencode:ses_one"].extra).toBe("keep");
    await unbindPlan(checkout, "ses_one");
    expect(readRegistry().custom).toEqual({ retained: true });
    expect(readRegistry().bindings.other).toEqual({ plan_name: "work" });
    expect(readRegistry().plans.work).toEqual(saved.plans.work);
  });

  test("serializes concurrent binders without losing either session", async () => {
    const path = plan();
    await Promise.all([bindPlan(checkout, "ses_one", path), bindPlan(checkout, "ses_two", path)]);
    expect(Object.keys(readRegistry().bindings).sort()).toEqual(["opencode:ses_one", "opencode:ses_two"]);
  });

  test("binding and pausing recheck execution authority under the registry lock", async () => {
    const path = plan();
    await expect(bindPlan(checkout, "ses_one", path, async () => { throw new Error("session moved"); })).rejects.toThrow("session moved");
    expect(boundPlan(checkout, "ses_one")).toBeNull();
    await bindPlan(checkout, "ses_one", path);
    const before = readFileSync(registryPath(), "utf8");
    await expect(unbindPlan(checkout, "ses_one", async () => { throw new Error("session moved"); })).rejects.toThrow("session moved");
    expect(readFileSync(registryPath(), "utf8")).toBe(before);
  });

  test("keeps the same native session isolated across checkout roots", async () => {
    await bindPlan(checkout, "ses_one", plan());
    const other = join(directory, "other");
    mkdirSync(other);
    expect(readSnapshot(other, "ses_one").plan).toBeNull();
    expect(existsSync(join(other, ".omca"))).toBe(false);
    expect(readSnapshot(checkout, "ses_one").plan?.name).toBe("work");
  });

  test("hashes exact bytes while reusing normalized checkbox/dependency parsing", async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(FINAL.replace(/\n/g, "\r\n"))]);
    const path = plan();
    writeFileSync(path, bytes);
    await bindPlan(checkout, "ses_one", path);
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.plan?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(snapshot.plan?.tasks).toEqual([
      { number: 1, label: "First task", checked: false, dependencies: [] },
      { number: 2, label: "Second task", checked: true, dependencies: [1] },
    ]);
    const before = { text: readFileSync(registryPath(), "utf8"), mtime: statSync(registryPath()).mtimeMs, files: readdirSync(join(checkout, ".omca", "state")) };
    readSnapshot(checkout, "ses_one");
    expect(readFileSync(registryPath(), "utf8")).toBe(before.text);
    expect(statSync(registryPath()).mtimeMs).toBe(before.mtime);
    expect(readdirSync(join(checkout, ".omca", "state"))).toEqual(before.files);
  });

  test.each(["{", "[]", '{"version":2}', '{"plans":[]}', '{"bindings":[]}'])("corrupt registry is visible and never overwritten: %s", async (text) => {
    put(registryPath(), text);
    expect(readSnapshot(checkout, "ses_one").health.some((item) => item.name === "registry" && item.state === "error")).toBe(true);
    expect(() => boundPlan(checkout, "ses_one")).toThrow();
    await expect(bindPlan(checkout, "ses_one", plan())).rejects.toThrow();
    await expect(unbindPlan(checkout, "ses_one")).rejects.toThrow();
    expect(readFileSync(registryPath(), "utf8")).toBe(text);
  });

  test.each([null, { plan_name: "missing" }, { plan_name: "../escape" }])("malformed/dangling bindings report unhealthy: %j", (binding) => {
    registry({ plans: {}, bindings: { "opencode:ses_one": binding } });
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.plan).toBeNull();
    expect(snapshot.health.some((item) => item.state === "error")).toBe(true);
  });

  test("an emptied admitted plan is unhealthy rather than complete", async () => {
    const path = plan();
    await bindPlan(checkout, "ses_one", path);
    writeFileSync(path, "Status: FINAL\n");
    ledger([evidence(createHash("sha256").update(readFileSync(path)).digest("hex"))]);
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.plan).toBeNull();
    expect(snapshot.evidence.verdict).toBe("missing");
    expect(snapshot.health.some((item) => item.name === "plan" && item.state === "error")).toBe(true);
  });
});

describe("shared native and legacy registry", () => {
  async function legacyWrite(path: string, name = "work"): Promise<string> {
    const write = legacyTools.find((tool) => tool.name === "boulder_write");
    if (write === undefined) throw new Error("Missing legacy boulder_write");
    return write.call({ active_plan: path, plan_name: name, session_id: "claude_session", working_directory: checkout, agent: "ignored" });
  }

  test("native bindings and metadata survive legacy registration, exit cleanup, and GC", async () => {
    const path = plan();
    const retained = plan("retained");
    registry({
      version: 1,
      custom: { keep: true },
      plans: {
        work: { active_plan: path, started_at: "old", session_ids: ["claude_session"], worktree_path: "/existing", agent: "stored", extension: { keep: true } },
        retained: { active_plan: retained, extension: "untouched" },
      },
      bindings: {
        "opencode:ses_one": { plan_name: "work", extra: "native" },
        claude_session: { plan_name: "work", extra: "legacy" },
        untouched: { plan_name: "retained", extra: "other" },
      },
    });
    await bindPlan(checkout, "ses_one", path);
    const native = readRegistry().bindings["opencode:ses_one"];
    const nativePlan = readBoundPlan(checkout, "ses_one");
    expect(await legacyWrite(path)).toBe("Boulder state written: plan=work, sessions=2");
    const registered = readRegistry();
    expect(registered.custom).toEqual({ keep: true });
    expect(registered.plans.work).toMatchObject({ agent: "stored", extension: { keep: true }, started_at: "old", worktree_path: "/existing", session_ids: ["claude_session", "opencode:ses_one"] });
    expect(registered.bindings["opencode:ses_one"]).toEqual(native);
    expect(registered.bindings.claude_session.extra).toBe("legacy");
    expect(readBoundPlan(checkout, "ses_one")).toEqual(nativePlan);
    expect(readdirSync(join(checkout, ".omca", "state"))).toEqual(["boulder.json"]);

    unbindBoundSessions(Date.now() + 1_000);
    const unbound = readRegistry();
    expect(unbound.bindings.claude_session).toBeUndefined();
    expect(unbound.bindings["opencode:ses_one"]).toEqual(native);
    expect(unbound.plans).toEqual(registered.plans);
    expect(unbound.custom).toEqual(registered.custom);

    unbound.plans.finished = { active_plan: plan("finished", FINAL.replace("[ ]", "[x]")), extension: "prunable" };
    unbound.bindings.orphan = { plan_name: "missing", extra: "prunable" };
    registry(unbound);
    expect(await gcRegistry(checkout)).toEqual({ pruned_plans: ["finished"], pruned_bindings: ["orphan"] });
    const collected = readRegistry();
    expect(collected.custom).toEqual(registered.custom);
    expect(collected.plans).toEqual(registered.plans);
    expect(collected.bindings).toEqual({ "opencode:ses_one": native, untouched: registered.bindings.untouched });
    expect(readBoundPlan(checkout, "ses_one")).toEqual(nativePlan);

    await unbindPlan(checkout, "ses_one");
    expect(readRegistry()).toEqual({ ...collected, bindings: { untouched: registered.bindings.untouched } });
  });

  test("native and legacy writers serialize updates to the same registry", async () => {
    const native = plan();
    const legacy = plan("legacy");
    await Promise.all([bindPlan(checkout, "ses_one", native), legacyWrite(legacy, "legacy")]);
    expect(readRegistry().bindings).toMatchObject({ "opencode:ses_one": { plan_name: "work" }, claude_session: { plan_name: "legacy" } });
    expect(Object.keys(readRegistry().plans).sort()).toEqual(["legacy", "work"]);
    expect(readBoundPlan(checkout, "ses_one")?.path).toBe(native);
  });

  test.each(["{", "[]", '{"version":2}', '{"plans":[]}', '{"bindings":[]}'])("both adapters protect an invalid shared registry: %s", async (text) => {
    const path = plan();
    await bindPlan(checkout, "ses_one", path);
    await legacyWrite(path);
    put(registryPath(), text);
    expect(() => readBoundPlan(checkout, "ses_one")).toThrow();
    await expect(bindPlan(checkout, "ses_one", path)).rejects.toThrow();
    await expect(unbindPlan(checkout, "ses_one")).rejects.toThrow();
    await expect(legacyWrite(path)).rejects.toThrow("cannot be updated");
    expect(await gcRegistry(checkout)).toEqual({ pruned_plans: [], pruned_bindings: [] });
    unbindBoundSessions(Date.now() + 1_000);
    expect(readFileSync(registryPath(), "utf8")).toBe(text);
  });
});

describe("bound plan reads", () => {
  test("returns null only when truly unbound, without creating state", () => {
    expect(readBoundPlan(checkout, "ses_one")).toBeNull();
    expect(readBoundPlan(checkout, "ses_one", null)).toBeNull();
    expect(existsSync(join(checkout, ".omca"))).toBe(false);
    const path = plan();
    registry({ plans: { work: { active_plan: path } }, bindings: { ses_one: { plan_name: "work" } } });
    expect(readBoundPlan(checkout, "ses_one")).toBeNull();
    expect(() => readBoundPlan(checkout, "")).toThrow("native session");
  });

  test("reads only the registry and bound plan, never ledger or notepads", async () => {
    const path = plan();
    await bindPlan(checkout, "ses_one", path);
    const expected = boundPlan(checkout, "ses_one");
    const snapshotPlan = readSnapshot(checkout, "ses_one").plan;
    const before = readFileSync(registryPath(), "utf8");
    const open = spyOn(fs, "openSync");
    try {
      expect(readBoundPlan(checkout, "ses_one", expected)).toEqual(snapshotPlan);
      expect(open.mock.calls.map(([file]) => file)).toEqual([registryPath(), path]);
    } finally {
      open.mockRestore();
    }
    expect(readFileSync(registryPath(), "utf8")).toBe(before);
  });

  test("compares the complete expected binding before opening a changed plan", async () => {
    await bindPlan(checkout, "ses_one", plan("one"));
    const expected = boundPlan(checkout, "ses_one");
    const two = plan("two");
    await bindPlan(checkout, "ses_one", two);
    const open = spyOn(fs, "openSync");
    try {
      expect(() => readBoundPlan(checkout, "ses_one", expected)).toThrow("binding changed");
      expect(() => readBoundPlan(checkout, "ses_one", null)).toThrow("binding changed");
      expect(open.mock.calls.map(([file]) => file)).toEqual([registryPath(), registryPath()]);
    } finally {
      open.mockRestore();
    }
    const current = boundPlan(checkout, "ses_one");
    expect(current).not.toBeNull();
    if (current === null) throw new Error("Expected a bound plan");
    expect(() => readBoundPlan(checkout, "ses_one", { ...current, worktreePath: "changed" })).toThrow("binding changed");
    const snapshot = readSnapshot(checkout, "ses_one", expected);
    expect(snapshot.plan).toBeNull();
    expect(snapshot.health.some((item) => item.name === "registry" && item.state === "error" && item.detail.includes("binding changed"))).toBe(true);
    expect(snapshot.health.some((item) => item.name === "ledger")).toBe(true);
    await unbindPlan(checkout, "ses_one");
    expect(() => readBoundPlan(checkout, "ses_one", current)).toThrow("binding changed");
  });

  test.each(["{", '{"plans":{},"bindings":{"opencode:ses_one":null}}', '{"plans":{},"bindings":{"opencode:ses_one":{"plan_name":"missing"}}}'])
  ("throws on corrupt or dangling bound state: %s", (text) => {
    put(registryPath(), text);
    expect(() => readBoundPlan(checkout, "ses_one")).toThrow();
    expect(readFileSync(registryPath(), "utf8")).toBe(text);
  });

  test("throws for a missing or invalid bound plan rather than returning null", async () => {
    const path = plan();
    await bindPlan(checkout, "ses_one", path);
    writeFileSync(path, "Status: DRAFT\n");
    expect(() => readBoundPlan(checkout, "ses_one")).toThrow("Status must be FINAL");
    rmSync(path);
    expect(() => readBoundPlan(checkout, "ses_one")).toThrow("ENOENT");
  });
});

describe("native input limits", () => {
  function sparse(path: string, size: number): void {
    put(path, "");
    truncateSync(path, size);
  }

  test.each(["registry", "ledger", "notepad"])("refuses oversized sparse %s files before reading or parsing", async (kind) => {
    await bindPlan(checkout, "ses_one", plan());
    const path = kind === "registry" ? registryPath() : kind === "ledger" ? ledgerPath() : join(checkout, ".omca", "notepads", "work", "issues.md");
    const name = kind === "notepad" ? "notepad:issues" : kind;
    sparse(path, STATE_FILE_BYTE_LIMIT + 1);
    const read = spyOn(fs, "readSync");
    try {
      if (kind === "registry") {
        expect(() => readBoundPlan(checkout, "ses_one")).toThrow(`${STATE_FILE_BYTE_LIMIT}-byte`);
        expect(read).not.toHaveBeenCalled();
      }
      const snapshot = readSnapshot(checkout, "ses_one");
      expect(snapshot.health.some((item) => item.name === name && item.state === "error" && item.detail.includes(`${STATE_FILE_BYTE_LIMIT}-byte`))).toBe(true);
      expect(snapshot.health.some((item) => item.name === "ledger")).toBe(true);
      expect(snapshot.notepads).toEqual([]);
      expect(read.mock.calls.every(([, buffer]) => (buffer as Buffer).length <= PLAN_FILE_BYTE_LIMIT + 1)).toBe(true);
    } finally {
      read.mockRestore();
    }
    expect(statSync(path).size).toBe(STATE_FILE_BYTE_LIMIT + 1);
  });

  test("refuses oversized sparse plans during admission and subsequent reads", async () => {
    const path = plan();
    sparse(path, PLAN_FILE_BYTE_LIMIT + 1);
    await expect(bindPlan(checkout, "ses_one", path)).rejects.toThrow(`${PLAN_FILE_BYTE_LIMIT}-byte`);
    expect(existsSync(join(checkout, ".omca"))).toBe(false);
    writeFileSync(path, FINAL);
    await bindPlan(checkout, "ses_one", path);
    sparse(path, PLAN_FILE_BYTE_LIMIT + 1);
    expect(() => readBoundPlan(checkout, "ses_one")).toThrow(`${PLAN_FILE_BYTE_LIMIT}-byte`);
    expect(readSnapshot(checkout, "ses_one").health.some((item) => item.name === "plan" && item.state === "error" && item.detail.includes(`${PLAN_FILE_BYTE_LIMIT}-byte`))).toBe(true);
  });

  test("bounds task graphs before dependency traversal and admits the task ceiling", async () => {
    const tasks = Array.from({ length: PLAN_TASK_LIMIT }, (_, index) => `- [ ] ${index + 1}. Task\n${index < PLAN_TASK_LIMIT - 1 ? `  - Depends: ${index + 2}\n` : ""}`).join("");
    const path = plan("large", `Status: FINAL\n${tasks}- [ ] ${PLAN_TASK_LIMIT + 1}. Extra\n`);
    await expect(bindPlan(checkout, "ses_one", path)).rejects.toThrow(`${PLAN_TASK_LIMIT}-task`);
    expect(existsSync(join(checkout, ".omca"))).toBe(false);
    writeFileSync(path, `Status: FINAL\n${tasks}`);
    await bindPlan(checkout, "ses_one", path);
    expect(readBoundPlan(checkout, "ses_one")?.tasks).toHaveLength(PLAN_TASK_LIMIT);
    writeFileSync(path, `Status: FINAL\n${tasks}- [ ] ${PLAN_TASK_LIMIT + 1}. Extra\n`);
    expect(() => readBoundPlan(checkout, "ses_one")).toThrow(`${PLAN_TASK_LIMIT}-task`);
    expect(readSnapshot(checkout, "ses_one").health.some((item) => item.name === "plan" && item.state === "error" && item.detail.includes(`${PLAN_TASK_LIMIT}-task`))).toBe(true);
  });

  test.each(["plan", "registry", "ledger", "notepad"])("refuses non-regular %s files", async (kind) => {
    const path = plan();
    await bindPlan(checkout, "ses_one", path);
    const file = kind === "plan" ? path : kind === "registry" ? registryPath() : kind === "ledger" ? ledgerPath() : join(checkout, ".omca", "notepads", "work", "issues.md");
    if (existsSync(file)) rmSync(file);
    mkdirSync(file, { recursive: true });
    const name = kind === "notepad" ? "notepad:issues" : kind;
    expect(readSnapshot(checkout, "ses_one").health.some((item) => item.name === name && item.state === "error" && item.detail.includes("regular file"))).toBe(true);
    if (kind === "plan" || kind === "registry") expect(() => readBoundPlan(checkout, "ses_one")).toThrow("regular file");
  });
});

describe("plan admission", () => {
  test.each([
    ["DRAFT", FINAL.replace("FINAL", "DRAFT")],
    ["unknown status", FINAL.replace("FINAL", "APPROVED")],
    ["status suffix", FINAL.replace("FINAL", "FINAL-ish")],
    ["missing status", FINAL.replace("**Status**: FINAL", "")],
    ["empty", "Status: FINAL\n"],
    ["duplicate", "Status: FINAL\n- [ ] 1. One\n- [x] 1. Two\n"],
    ["unknown dependency", FINAL.replace("Depends on: 1", "Depends on: 99")],
    ["self dependency", FINAL.replace("Depends on: 1", "Depends on: 2")],
    ["bad dependency", FINAL.replace("Depends on: 1", "Depends on: -1")],
    ["nonnumeric dependency", FINAL.replace("Depends on: 1", "Depends on: later")],
    ["cycle", "Status: FINAL\n- [ ] 1. One\n  - Depends: 2\n- [ ] 2. Two\n  - Depends: 1\n"],
    ["zero", "Status: FINAL\n- [ ] 0. Zero\n"],
  ])("rejects %s before creating state", async (_label, source) => {
    await expect(bindPlan(checkout, "ses_one", plan("invalid", source))).rejects.toThrow();
    expect(existsSync(join(checkout, ".omca"))).toBe(false);
  });

  test("ignores fenced examples and accepts explicit no dependencies", async () => {
    const path = plan("fences", `${FINAL.replace("Depends on: 1", "Depends on: None")}\n\`\`\`md\nStatus: DRAFT\n- [ ] 1. Example\n\`\`\`\n`);
    await bindPlan(checkout, "ses_one", path);
    expect(readSnapshot(checkout, "ses_one").plan?.tasks).toHaveLength(2);
  });

  test("rejects blank native context without falling back to process session", async () => {
    await expect(bindPlan(checkout, "", plan())).rejects.toThrow("native session");
    expect(readSnapshot(checkout, "").health.some((item) => item.name === "context" && item.state === "error")).toBe(true);
    expect(existsSync(join(checkout, ".omca"))).toBe(false);
  });

  test("rejects path traversal, sibling-prefix paths, and symlink escapes", async () => {
    const outside = put(join(directory, "checkout-other", "outside.md"), FINAL);
    await expect(bindPlan(checkout, "ses_one", outside)).rejects.toThrow("outside");
    await expect(bindPlan(checkout, "ses_one", "../checkout-other/outside.md")).rejects.toThrow("outside");
    const link = join(checkout, "escape.md");
    symlinkSync(outside, link);
    await expect(bindPlan(checkout, "ses_one", link)).rejects.toThrow("symlink");
    registry({ plans: { escape: { active_plan: link } }, bindings: { "opencode:ses_one": { plan_name: "escape" } } });
    expect(readSnapshot(checkout, "ses_one").plan).toBeNull();
    expect(() => readBoundPlan(checkout, "ses_one")).toThrow("symlink");
  });

  test("refuses redirected state writes and snapshot reads", async () => {
    const outside = join(directory, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(checkout, ".omca"));
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.health.filter((item) => item.state === "error").map((item) => item.name)).toEqual(["registry", "ledger"]);
    await expect(bindPlan(checkout, "ses_one", plan())).rejects.toThrow("symlink");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("refuses a dangling state symlink", async () => {
    symlinkSync(join(directory, "missing"), join(checkout, ".omca"));
    await expect(bindPlan(checkout, "ses_one", plan())).rejects.toThrow("symlink");
    expect(existsSync(join(directory, "missing"))).toBe(false);
  });

  test.each([".lock", ".lock.d", ".lock.break", ".lock.break.d"])("refuses redirected lock artifacts: %s", async (suffix) => {
    const outside = join(directory, "outside");
    mkdirSync(outside);
    mkdirSync(join(checkout, ".omca", "state"), { recursive: true });
    symlinkSync(outside, `${registryPath()}${suffix}`);
    await expect(bindPlan(checkout, "ses_one", plan())).rejects.toThrow("symlink");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("admits only the native home plan directory outside a checkout", () => {
    const home = join(directory, "home");
    const path = put(join(home, ".opencode", "plan", "home-plan.md"), FINAL);
    const outside = put(join(home, "other", "outside.md"), FINAL);
    symlinkSync(outside, join(home, ".opencode", "plan", "escape.md"));
    const result = Bun.spawnSync([process.execPath, "-e", `
      import { bindPlan, readSnapshot } from ${JSON.stringify(join(import.meta.dir, "state.ts"))};
      await bindPlan(${JSON.stringify(checkout)}, "ses_home", "~/.opencode/plan/home-plan.md");
      const snapshot = readSnapshot(${JSON.stringify(checkout)}, "ses_home");
      if (snapshot.plan?.path !== ${JSON.stringify(path)}) throw new Error("Home plan was not admitted");
      for (const path of [${JSON.stringify(outside)}, "~/.opencode/plan/escape.md"]) {
        let refused = false;
        try { await bindPlan(${JSON.stringify(checkout)}, "ses_other", path); } catch { refused = true; }
        if (!refused) throw new Error("Unsafe home path was admitted");
      }
    `], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("does not replace another plan having the same basename", async () => {
    const first = plan();
    await bindPlan(checkout, "ses_one", first);
    const second = put(join(checkout, "other", "work.md"), FINAL);
    await expect(bindPlan(checkout, "ses_two", second)).rejects.toThrow("different plan");
    expect(boundPlan(checkout, "ses_one")?.path).toBe(first);
    expect(boundPlan(checkout, "ses_two")).toBeNull();
  });
});

describe("evidence and notepads", () => {
  test("matching legacy success is only historical; unscoped success is not verification", async () => {
    await bindPlan(checkout, "ses_one", plan());
    const hash = readSnapshot(checkout, "ses_one").plan?.sha256 ?? "";
    ledger([evidence("")]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("missing");
    ledger([evidence(hash)]);
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.evidence.verdict).toBe("historical");
    expect(snapshot.health.some((item) => item.name === "verification" && item.state === "warning" && item.detail.includes("not supported"))).toBe(true);
    ledger([evidence("a".repeat(64))]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("stale");
  });

  test("newer applicable failures invalidate success; unrelated hash failures do not", async () => {
    await bindPlan(checkout, "ses_one", plan());
    const hash = readSnapshot(checkout, "ses_one").plan?.sha256 ?? "";
    ledger([evidence(hash), evidence("", { type: "test", exit_code: 1 })]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("stale");
    ledger([evidence(hash), evidence(hash, { type: "test", exit_code: 1 })]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("stale");
    ledger([evidence(hash), evidence("b".repeat(64), { type: "test", exit_code: 1 })]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("historical");
  });

  test("interleaved plan finals retain each plan's latest matching history", async () => {
    await bindPlan(checkout, "ses_one", plan("one"));
    await bindPlan(checkout, "ses_two", plan("two", FINAL.replace("First task", "Other task")));
    const one = readSnapshot(checkout, "ses_one").plan?.sha256 ?? "";
    const two = readSnapshot(checkout, "ses_two").plan?.sha256 ?? "";
    ledger([evidence(one), evidence(two)]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("historical");
    expect(readSnapshot(checkout, "ses_two").evidence.verdict).toBe("historical");
    ledger([evidence(one), evidence(two), evidence(two, { exit_code: 1 })]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("historical");
    expect(readSnapshot(checkout, "ses_two").evidence.verdict).toBe("stale");
    ledger([evidence(one), evidence(two), evidence(one, { exit_code: 1 }), evidence(two)]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("stale");
    expect(readSnapshot(checkout, "ses_two").evidence.verdict).toBe("historical");
    ledger([evidence(one), evidence(one, { exit_code: 1 }), evidence(one), evidence(two)]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("historical");
  });

  test.each([
    [[0, 1, 0], "historical"],
    [[0, 0, 1], "stale"],
    [[1, 0, 0], "historical"],
    [[1, 0, 1], "stale"],
  ] as const)("uses the newest matching final across relevant results %j", async (results, verdict) => {
    await bindPlan(checkout, "ses_one", plan());
    const hash = readBoundPlan(checkout, "ses_one")?.sha256 ?? "";
    ledger(results.flatMap((exit_code) => [evidence(hash, { exit_code }), evidence("c".repeat(64))]));
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe(verdict);
  });

  test("only a newer matching final restores history after an applicable failure", async () => {
    await bindPlan(checkout, "ses_one", plan());
    const hash = readBoundPlan(checkout, "ses_one")?.sha256 ?? "";
    const entries = [evidence(hash), evidence("", { type: "test", exit_code: 1 }), evidence("d".repeat(64))];
    ledger(entries);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("stale");
    ledger([...entries, evidence(hash), evidence("", { type: "test", exit_code: 0 }), evidence("d".repeat(64), { exit_code: 1 })]);
    expect(readSnapshot(checkout, "ses_one").evidence.verdict).toBe("historical");
  });

  test.each(["{", "[]", '{"version":2}', '{"entries":{}}'])("corrupt ledger is distinguishable from missing: %s", (text) => {
    put(ledgerPath(), text);
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.evidence.entries).toEqual([]);
    expect(snapshot.health.some((item) => item.name === "ledger" && item.state === "error")).toBe(true);
    expect(readFileSync(ledgerPath(), "utf8")).toBe(text);
  });

  test("malformed ledger entries are visible without hiding good entries", () => {
    ledger([null, evidence("")]);
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.evidence.entries).toHaveLength(1);
    expect(snapshot.health.some((item) => item.name === "ledger" && item.state === "warning")).toBe(true);
  });

  test("bounds newest evidence and per-section notepads, and redacts before truncation", async () => {
    await bindPlan(checkout, "ses_one", plan());
    ledger(Array.from({ length: 60 }, (_, index) => evidence("", { command: `run ${index} api_key=private-value`, output_snippet: "token=private-value " + "x".repeat(3_000) })));
    put(join(checkout, ".omca", "notepads", "work", "learnings.md"), `## 2026-10-14T10:00:00Z\n\n${"old\n".repeat(3_000)}\n## 2026-10-15T10:00:00Z\n\ntoken=private-value newest\n`);
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.evidence.entries).toHaveLength(50);
    expect(snapshot.evidence.entries[0]?.command).toBe("run 10 api_key=<masked>");
    expect(snapshot.evidence.entries.at(-1)?.command).toBe("run 59 api_key=<masked>");
    expect(snapshot.evidence.entries.every((entry) => entry.snippet.length <= 2_000)).toBe(true);
    expect(snapshot.notepads[0]?.content.length).toBeLessThanOrEqual(8_000);
    expect(snapshot.notepads[0]?.content).toContain("token=<masked> newest");
    expect(JSON.stringify(snapshot)).not.toContain("private-value");
  });

  test("does not read notepad symlinks outside the checkout", async () => {
    await bindPlan(checkout, "ses_one", plan());
    const outside = put(join(directory, "private.md"), "do-not-read-sentinel");
    mkdirSync(join(checkout, ".omca", "notepads", "work"), { recursive: true });
    symlinkSync(outside, join(checkout, ".omca", "notepads", "work", "issues.md"));
    const snapshot = readSnapshot(checkout, "ses_one");
    expect(snapshot.notepads).toEqual([]);
    expect(snapshot.health.some((item) => item.name === "notepad:issues" && item.state === "error")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("do-not-read-sentinel");
  });
});
