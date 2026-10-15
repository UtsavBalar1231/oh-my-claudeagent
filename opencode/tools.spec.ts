import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tools as astTools } from "../servers/tools/ast.ts";
import { LEDGER } from "../src/core/omca-paths.ts";
import { withLock } from "../servers/io.ts";
import * as state from "./state.ts";
import { bindPlan } from "./state.ts";
import { registerTools } from "./tools.ts";

const dirs: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory() {
  const dir = mkdtempSync(join(tmpdir(), "omca-native-tools-"));
  dirs.push(dir);
  return dir;
}

type Assertion = { sessionID: string; agent: string; action: string; resources: string[]; source: { type: string; messageID: string; id: string } };

async function fake() {
  const a = directory();
  const b = directory();
  const locations = new Map([["ses_a", a], ["ses_b", b]]);
  const agents = new Map<string, string>();
  const tools = new Map<string, Info>();
  const assertions: Assertion[] = [];
  const changes: string[] = [];
  let permission = (_input: Assertion) => {};
  let reportProgress = (_update: Record<string, unknown>) => {};
  const ctx = {
    location: { directory: a },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ location: { directory: locations.get(sessionID)! }, ...(agents.has(sessionID) && { agent: agents.get(sessionID) }) }) },
    permission: { assert: async (input: Assertion) => { assertions.push(input); permission(input); } },
    tool: {
      transform: async (callback: (editor: ToolEditor) => void) => {
        callback({ namespace: () => {}, add: (tool: Info) => { tools.set(`omca_${tool.name}`, tool); } } as unknown as ToolEditor);
        return { dispose: async () => {} };
      },
    },
  } as unknown as Plugin.Context;
  await registerTools(ctx, async (sessionID) => { changes.push(sessionID); });
  const progress: Record<string, unknown>[] = [];
  const call = async (name: string, input: Record<string, unknown> = {}, sessionID = "ses_a", agent = "build", id: string = crypto.randomUUID(), signal = new AbortController().signal, messageID = "msg_1") => {
    const tool = tools.get(`omca_${name}`);
    if (!tool) throw new Error(`Missing native tool ${name}`);
    return tool.execute(input, { sessionID, agent, messageID, id, signal, progress: async (update: Record<string, unknown>) => { progress.push(update); reportProgress(update); } } as unknown as ToolContext);
  };
  return { a, b, locations, agents, assertions, changes, tools, progress, call, deny: (fn: typeof permission) => { permission = fn; }, onProgress: (fn: typeof reportProgress) => { reportProgress = fn; } };
}

const note = { plan_name: "native", section: "learnings", content: "session-specific" };
const evidence = { evidence_type: "test", command: "bun test", exit_code: 1, output_snippet: "one failing test" };
const ledger = (root: string) => join(root, LEDGER);
const section = (root: string) => join(root, ".omca", "notepads", "native", "learnings.md");
const permissionPath = (path: string) => path.replaceAll("\\", "/");

test("registers stable native names with direct workflow tools and no boulder writer", async () => {
  const f = await fake();
  for (const name of ["evidence_log", "boulder_progress", "notepad_write"]) expect(f.tools.get(`omca_${name}`)?.options?.codemode).toBe(false);
  for (const name of ["evidence_read", "notepad_read", "file_read", "ast_search"]) expect(f.tools.get(`omca_${name}`)?.options?.codemode).toBe(true);
  expect(f.tools.has("omca_boulder_write")).toBe(false);
  for (const tool of f.tools.values()) {
    const input = tool.input as { properties: Record<string, unknown> };
    expect(input.properties).not.toHaveProperty("working_directory");
    expect(input.properties).not.toHaveProperty("session_id");
  }
  expect(f.tools.get("omca_evidence_log")?.description).not.toContain("stop gate");
});

test("interleaved native sessions write only their current checkout and notify the right session", async () => {
  const f = await fake();
  await Promise.all([f.call("notepad_write", note), f.call("evidence_log", evidence, "ses_b")]);
  expect(readFileSync(section(f.a), "utf8")).toContain("session-specific");
  expect(existsSync(ledger(f.a))).toBe(false);
  expect(existsSync(section(f.b))).toBe(false);
  expect(JSON.parse(readFileSync(ledger(f.b), "utf8")).entries[0]).toMatchObject({ origin: "attested", exit_code: 1, provenance: { adapter: "opencode", session_id: "ses_b" } });
  expect(f.changes.toSorted()).toEqual(["ses_a", "ses_b"]);
  f.locations.set("ses_a", f.b);
  await f.call("notepad_write", note);
  expect(existsSync(section(f.b))).toBe(true);
});

test("native action and edit denials do not create OMCA state", async () => {
  const f = await fake();
  f.deny((input) => { if (input.action === "omca_notepad_write") throw new Error("action denied"); });
  await expect(f.call("notepad_write", note)).rejects.toThrow("action denied");
  expect(existsSync(join(f.a, ".omca"))).toBe(false);
  f.deny((input) => { if (input.action === "edit") throw new Error("read-only custom agent"); });
  await expect(f.call("notepad_write", note, "ses_a", "review-only")).rejects.toThrow("read-only custom agent");
  expect(existsSync(join(f.a, ".omca"))).toBe(false);
  expect(f.changes).toEqual([]);
});

test("plan agent cannot log evidence, append, compact, or apply AST edits", async () => {
  const f = await fake();
  for (const [name, args] of [["evidence_log", evidence], ["notepad_write", note], ["notepad_compact", note], ["ast_replace", { dry_run: false }]] as const) {
    await expect(f.call(name, args, "ses_a", "plan")).rejects.toThrow("plan agent");
  }
  expect(existsSync(join(f.a, ".omca"))).toBe(false);
});

test("rejects root/session overrides and session moves during approval", async () => {
  const f = await fake();
  await expect(f.call("evidence_log", { ...evidence, working_directory: f.b })).rejects.toThrow("cannot override");
  await expect(f.call("evidence_log", { ...evidence, session_id: "ses_b" })).rejects.toThrow("cannot override");
  f.deny((input) => { if (input.action === "edit") f.locations.set("ses_a", f.b); });
  await expect(f.call("evidence_log", evidence)).rejects.toThrow("Session location changed");
  expect(existsSync(ledger(f.a))).toBe(false);
  expect(existsSync(ledger(f.b))).toBe(false);
});

test("queued native notepad writes recheck the session location after obtaining their lock", async () => {
  const f = await fake();
  let unlock!: () => void;
  let acquired!: () => void;
  const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
  const releasePromise = new Promise<void>((resolve) => { unlock = resolve; });
  const held = withLock(`${section(f.a)}.lock`, async () => { acquired(); await releasePromise; });
  await acquiredPromise;
  const write = f.call("notepad_write", note);
  const verdict = write.then(() => null, (error: unknown) => error);
  while (!f.assertions.some((input) => input.action === "edit")) await Bun.sleep(1);
  f.locations.set("ses_a", f.b);
  unlock();
  await held;
  expect(String(await verdict)).toContain("Session location changed");
  expect(existsSync(section(f.a))).toBe(false);
  expect(existsSync(section(f.b))).toBe(false);
});

test.each(["notepad_write", "evidence_log"])("queued %s refuses a switch to Plan under the shared lock", async (name) => {
  const f = await fake();
  f.agents.set("ses_a", "build");
  const path = name === "notepad_write" ? section(f.a) : ledger(f.a);
  let unlock!: () => void;
  let acquired!: () => void;
  const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
  const releasePromise = new Promise<void>((resolve) => { unlock = resolve; });
  const held = withLock(`${path}.lock`, async () => { acquired(); await releasePromise; });
  await acquiredPromise;
  const write = f.call(name, name === "notepad_write" ? note : evidence);
  const verdict = write.then(() => null, (error: unknown) => error);
  while (!f.assertions.some((input) => input.action === "edit")) await Bun.sleep(1);
  f.agents.set("ses_a", "plan");
  unlock();
  await held;
  expect(String(await verdict)).toContain("switched to the plan agent");
  expect(existsSync(path)).toBe(false);
  expect(f.assertions.every((input) => input.agent === "build")).toBe(true);
});

test("internal permission resources use active-location-relative paths, including parent checkout files", async () => {
  const f = await fake();
  expect(Bun.spawnSync(["git", "init", "-q", f.a]).exitCode).toBe(0);
  const pkg = join(f.a, "pkg");
  mkdirSync(pkg);
  f.locations.set("ses_a", pkg);
  writeFileSync(join(pkg, "source.txt"), "package file");
  writeFileSync(join(f.a, "parent.txt"), "parent file");
  await f.call("file_read", { path: join(pkg, "source.txt") }, "ses_a", "plan");
  await f.call("file_read", { path: join(f.a, "parent.txt") }, "ses_a", "plan");
  await f.call("notepad_write", note);
  expect(f.assertions).toContainEqual(expect.objectContaining({ action: "read", resources: ["source.txt"] }));
  expect(f.assertions).toContainEqual(expect.objectContaining({ action: "read", resources: ["../parent.txt"] }));
  expect(f.assertions.some((input) => input.action === "edit" && input.resources.includes("../.omca/notepads/native/learnings.md"))).toBe(true);
  expect(f.assertions.some((input) => input.action === "external_directory")).toBe(false);
  expect(existsSync(section(f.a))).toBe(true);
  expect(existsSync(join(pkg, ".omca"))).toBe(false);
});

test("read-only tools do not initialize missing state and progress never inherits another session binding", async () => {
  const f = await fake();
  await f.call("evidence_read");
  await f.call("notepad_list");
  await f.call("notepad_read", { plan_name: "native" });
  const unbound = await f.call("boulder_progress");
  expect(JSON.parse(String(unbound.content)).plan).toBeNull();
  expect(existsSync(join(f.a, ".omca"))).toBe(false);
  const plan = join(f.a, "plan.md");
  writeFileSync(plan, "Status: FINAL\n\n- [x] 1. done\n- [ ] 2. next\n");
  await bindPlan(f.a, "ses_b", plan);
  expect(JSON.parse(String((await f.call("boulder_progress")).content)).plan).toBeNull();
  await bindPlan(f.a, "ses_a", plan);
  expect(JSON.parse(String((await f.call("boulder_progress")).content))).toMatchObject({ total: 2, completed: 1, remaining: 1, next_task_label: "next" });
});

test("snapshot inspection passes the approved binding and cannot substitute a newly bound plan", async () => {
  const f = await fake();
  const approvedPlan = join(f.a, "approved.md");
  const otherPlan = join(f.a, "other.md");
  writeFileSync(approvedPlan, "Status: FINAL\n\n- [ ] 1. approved task\n");
  writeFileSync(otherPlan, "Status: FINAL\n\n- [ ] 1. NEVER_EXPOSE_UNAPPROVED_TASK\n");
  await bindPlan(f.a, "ses_a", approvedPlan);
  const registryPath = join(f.a, ".omca", "state", "boulder.json");
  const approvedRegistry = readFileSync(registryPath, "utf8");
  await bindPlan(f.a, "ses_a", otherPlan);
  const swappedRegistry = readFileSync(registryPath, "utf8");
  writeFileSync(registryPath, approvedRegistry);
  const original = state.readBoundPlan;
  const spy = spyOn(state, "readBoundPlan").mockImplementation((directory, sessionID, expected) => {
    expect(expected).toMatchObject({ name: "approved", path: approvedPlan });
    writeFileSync(registryPath, swappedRegistry);
    return original(directory, sessionID, expected);
  });
  restores.push(() => spy.mockRestore());
  await expect(f.call("boulder_progress")).rejects.toThrow("Plan binding changed");
  expect(spy).toHaveBeenCalledTimes(1);
});

test("evidence validates integer exits, deduplicates call retries, and preserves ledger shape", async () => {
  const f = await fake();
  await expect(f.call("evidence_log", { ...evidence, exit_code: 0.5 })).rejects.toThrow("integer");
  await expect(f.call("evidence_log", { ...evidence, exit_code: "0" })).rejects.toThrow("integer");
  expect(existsSync(ledger(f.a))).toBe(false);
  await f.call("evidence_log", { ...evidence, command: "x".repeat(2500), output_snippet: "y".repeat(2500) }, "ses_a", "build", "call_retry");
  await f.call("evidence_log", evidence, "ses_a", "build", "call_retry");
  const data = JSON.parse(readFileSync(ledger(f.a), "utf8"));
  expect(data.version).toBe(1);
  expect(data.entries).toHaveLength(1);
  expect(data.entries[0].command).toHaveLength(2000);
  expect(data.entries[0].output_snippet).toHaveLength(2000);
  writeFileSync(ledger(f.a), "broken");
  await expect(f.call("evidence_log", evidence)).rejects.toThrow(`${ledger(f.a)} is not an evidence ledger ({"entries": [...]}); move it aside to keep logging evidence`);
  expect(readFileSync(ledger(f.a), "utf8")).toBe("broken");
});

test("evidence deduplication includes the native message identity", async () => {
  const f = await fake();
  const signal = new AbortController().signal;
  await f.call("evidence_log", evidence, "ses_a", "build", "call_reused", signal, "msg_one");
  await f.call("evidence_log", evidence, "ses_a", "build", "call_reused", signal, "msg_one");
  await f.call("evidence_log", evidence, "ses_a", "build", "call_reused", signal, "msg_two");
  const entries = JSON.parse(readFileSync(ledger(f.a), "utf8")).entries;
  expect(entries).toHaveLength(2);
  expect(entries[0].record_id).not.toBe(entries[1].record_id);
  expect(entries.map((entry: { provenance: { message_id: string } }) => entry.provenance.message_id)).toEqual(["msg_one", "msg_two"]);
});

test("progress and final evidence do not require unrelated notepad or ledger reads", async () => {
  const f = await fake();
  const plan = join(f.a, "plan.md");
  writeFileSync(plan, "Status: FINAL\n\n- [x] 1. Done\n");
  await bindPlan(f.a, "ses_a", plan);
  f.deny((input) => {
    if (input.action === "read" && input.resources.some((resource) => resource.includes("notepads") || resource.includes("verification-evidence"))) throw new Error("unrelated state denied");
  });
  const progress = JSON.parse(String((await f.call("boulder_progress")).content));
  expect(progress.completed).toBe(1);
  f.deny((input) => {
    if (input.action === "read" && input.resources.some((resource) => resource.includes("notepads"))) throw new Error("notepads denied");
  });
  await f.call("evidence_log", { ...evidence, evidence_type: "final_verification", exit_code: 0, plan_sha256: progress.plan_sha256 });
  expect(JSON.parse(readFileSync(ledger(f.a), "utf8")).entries).toHaveLength(1);
});

test("notepad listing formats only the directories vetted before approval", async () => {
  const f = await fake();
  const base = join(f.a, ".omca", "notepads");
  mkdirSync(join(base, "native"), { recursive: true });
  writeFileSync(join(base, "native", "learnings.md"), "known");
  writeFileSync(join(f.b, "PRIVATE_SECTION_SENTINEL.md"), "outside");
  let inserted = false;
  f.deny((input) => {
    if (!inserted && input.action === "read" && input.resources.includes(".omca/notepads/native")) {
      inserted = true;
      symlinkSync(f.b, join(base, "new-plan"), "dir");
    }
  });
  const listed = String((await f.call("notepad_list")).content);
  expect(inserted).toBe(true);
  expect(listed).toContain("native: learnings");
  expect(listed).not.toContain("new-plan");
  expect(listed).not.toContain("PRIVATE_SECTION_SENTINEL");
});

test.each([["evidence_log", "read"], ["evidence_log", "edit"], ["file_read", "read"], ["file_read", "edit"]])("first %s initializes ignored state only after gitignore %s approval", async (name, action) => {
  const f = await fake();
  writeFileSync(join(f.a, "source.txt"), "source");
  const input = name === "evidence_log" ? evidence : { path: "source.txt" };
  f.deny((assertion) => {
    if (assertion.action === action && assertion.resources.includes(".omca/.gitignore")) throw new Error("ignore denied");
  });
  await expect(f.call(name, input)).rejects.toThrow("ignore denied");
  expect(existsSync(join(f.a, ".omca"))).toBe(false);
  f.deny(() => {});
  await f.call(name, input);
  expect(readFileSync(join(f.a, ".omca", ".gitignore"), "utf8")).toBe("*\n!/rules/\n!/rules/**\n");
});

test("final verification requires an explicit binding and exact current hash; health remains historical", async () => {
  const f = await fake();
  const final = { ...evidence, evidence_type: "final_verification", exit_code: 0, plan_sha256: "a".repeat(64) };
  await expect(f.call("evidence_log", final)).rejects.toThrow("exact current hash");
  const plan = join(f.a, "plan.md");
  writeFileSync(plan, "Status: FINAL\n\n- [x] 1. done\n");
  await bindPlan(f.a, "ses_a", plan);
  await expect(f.call("evidence_log", final)).rejects.toThrow("exact current hash");
  const progress = JSON.parse(String((await f.call("boulder_progress")).content));
  await f.call("evidence_log", { ...final, plan_sha256: progress.plan_sha256 });
  expect(JSON.parse(String((await f.call("health_check")).content)).verification).toBe("historical");
  expect(JSON.parse(readFileSync(ledger(f.a), "utf8")).entries[0].origin).toBe("attested");
});

test("OMCA state symlinks cannot redirect reads or writes", async () => {
  const f = await fake();
  symlinkSync(f.b, join(f.a, ".omca"), "dir");
  await expect(f.call("notepad_write", note)).rejects.toThrow("symlinks");
  await expect(f.call("evidence_read")).rejects.toThrow("symlinks");
  expect(existsSync(join(f.b, "state"))).toBe(false);
});

test("file reads check sensitive originals and canonical targets and external boundary permission", async () => {
  const f = await fake();
  const hidden = join(f.a, ".env");
  writeFileSync(hidden, "DO_NOT_READ=1");
  symlinkSync(hidden, join(f.a, "innocent.txt"));
  await expect(f.call("file_read", { path: hidden }, "ses_a", "plan")).rejects.toThrow("sensitive");
  await expect(f.call("file_read", { path: "innocent.txt" }, "ses_a", "plan")).rejects.toThrow("sensitive");
  await expect(f.call("file_read", { path: "//host/share/file" }, "ses_a", "plan")).rejects.toThrow("Network");
  const external = join(f.b, "public.txt");
  writeFileSync(external, "outside permitted");
  symlinkSync(external, join(f.a, "link.txt"));
  const result = await f.call("file_read", { path: "link.txt" }, "ses_a", "plan");
  expect(String(result.content)).toContain("outside permitted");
  expect(f.assertions).toContainEqual(expect.objectContaining({ action: "external_directory", resources: [permissionPath(join(f.b, "*"))] }));
  expect(f.assertions).toContainEqual(expect.objectContaining({ action: "read", resources: ["link.txt", permissionPath(external)], agent: "plan", source: expect.objectContaining({ type: "tool", messageID: "msg_1" }) }));
  expect(existsSync(join(f.a, ".omca"))).toBe(false);
});

test("non-plan file reads audit the executing checkout, not the plugin cwd", async () => {
  const f = await fake();
  writeFileSync(join(f.b, "file.txt"), "session b");
  const read = await f.call("file_read", { path: "file.txt" }, "ses_b");
  expect(String(read.content)).toContain("session b");
  const log = join(f.b, ".omca", "logs", "file-access.jsonl");
  expect(JSON.parse(readFileSync(log, "utf8"))).toMatchObject({ path: join(f.b, "file.txt"), allowed: true });
  expect(existsSync(join(f.a, ".omca"))).toBe(false);
});

test("denying any AST candidate prevents CLI invocation and directory scopes fail explicitly", async () => {
  const f = await fake();
  for (const name of ["first.ts", "denied.ts"]) writeFileSync(join(f.a, name), "foo(1)");
  const descriptor = astTools.find((tool) => tool.name === "ast_search")!;
  const spy = spyOn(descriptor, "call").mockImplementation(async () => "must not run");
  restores.push(() => spy.mockRestore());
  f.deny((input) => { if (input.action === "read" && input.resources.includes("denied.ts")) throw new Error("candidate denied"); });
  await expect(f.call("ast_search", { pattern: "foo($A)", lang: "typescript", paths: ["first.ts", "denied.ts"] })).rejects.toThrow("candidate denied");
  expect(spy).not.toHaveBeenCalled();
  await expect(f.call("ast_search", { pattern: "foo($A)", lang: "typescript", paths: ["."] })).rejects.toThrow("not directories");
  await expect(f.call("ast_search", { pattern: "foo($A)", lang: "typescript" })).rejects.toThrow("explicit regular-file");
});

test("path-scoped native action denials apply before the underlying AST handler", async () => {
  const f = await fake();
  writeFileSync(join(f.a, "source.ts"), "foo(1)");
  const descriptor = astTools.find((tool) => tool.name === "ast_search")!;
  const spy = spyOn(descriptor, "call").mockImplementation(async () => "must not run");
  restores.push(() => spy.mockRestore());
  f.deny((input) => { if (input.action === "omca_ast_search" && input.resources.includes("source.ts")) throw new Error("scoped action denied"); });
  await expect(f.call("ast_search", { pattern: "foo($A)", lang: "typescript", paths: ["source.ts"] })).rejects.toThrow("scoped action denied");
  expect(spy).not.toHaveBeenCalled();
});

test("AST apply requires the same session, arguments, unchanged contents, and edit approval", async () => {
  const f = await fake();
  const file = join(f.a, "source.ts");
  writeFileSync(file, "foo(1)");
  const descriptor = astTools.find((tool) => tool.name === "ast_replace")!;
  const spy = spyOn(descriptor, "call").mockImplementation(async (args, shared) => {
    expect(shared?.workspaceRoot).toBe(f.a);
    expect(shared?.signal).toBeInstanceOf(AbortSignal);
    shared?.progress({ message: "working", progress: 1 });
    if (args.dry_run === false) writeFileSync(file, "bar(1)");
    return args.dry_run === false ? "applied" : "[DRY RUN] 1 replacement";
  });
  restores.push(() => spy.mockRestore());
  const args = { pattern: "foo($A)", rewrite: "bar($A)", lang: "typescript", paths: ["source.ts"] };
  await expect(f.call("ast_replace", { ...args, dry_run: false })).rejects.toThrow("dry_run=true");
  await f.call("ast_replace", args);
  expect(f.progress).toContainEqual(expect.objectContaining({ status: "working", progress: 1 }));
  f.locations.set("ses_b", f.a);
  await expect(f.call("ast_replace", { ...args, dry_run: false }, "ses_b")).rejects.toThrow("dry_run=true");
  writeFileSync(file, "foo(2)");
  await expect(f.call("ast_replace", { ...args, dry_run: false })).rejects.toThrow("dry_run=true");
  await f.call("ast_replace", args);
  f.deny((input) => { if (input.action === "edit") throw new Error("edit denied"); });
  await expect(f.call("ast_replace", { ...args, dry_run: false })).rejects.toThrow("edit denied");
  expect(readFileSync(file, "utf8")).toBe("foo(2)");
  f.deny(() => {});
  await f.call("ast_replace", { ...args, dry_run: false });
  expect(readFileSync(file, "utf8")).toBe("bar(1)");
  expect(f.changes).toEqual(["ses_a"]);
});

test("native AST uses explicit workspace and ignores repository ast-grep configuration", async () => {
  const f = await fake();
  writeFileSync(join(f.b, "source.ts"), "foo(42)");
  writeFileSync(join(f.b, "sgconfig.yml"), "this: is not a valid ast-grep config");
  const result = await f.call("ast_search", { pattern: "foo($A)", lang: "typescript", paths: ["source.ts"] }, "ses_b", "plan");
  expect(String(result.content)).toContain("foo(42)");
  expect(f.progress.some((update) => update.status === "ast-grep running")).toBe(true);
  expect(existsSync(join(f.b, ".omca"))).toBe(false);
});

test("native AST YAML, snippet and preview/apply handlers work with isolated CLI configuration", async () => {
  const f = await fake();
  const file = join(f.a, "source.ts");
  writeFileSync(file, "foo(42)");
  const rule = "id: test\nlanguage: typescript\nrule:\n  pattern: foo($A)\n";
  expect(String((await f.call("ast_find_rule", { rule_yaml: rule, paths: ["source.ts"] })).content)).toContain("foo(42)");
  expect(String((await f.call("ast_test_rule", { rule_yaml: rule, code: "foo(42)" })).content)).toContain("foo(42)");
  expect(String((await f.call("ast_dump_tree", { language: "typescript", code: "foo(42)" })).content)).toContain("call_expression");
  const args = { pattern: "foo($A)", rewrite: "bar($A)", lang: "typescript", paths: ["source.ts"] };
  expect(String((await f.call("ast_replace", args)).content)).toContain("[DRY RUN]");
  expect(readFileSync(file, "utf8")).toBe("foo(42)");
  await f.call("ast_replace", { ...args, dry_run: false });
  expect(readFileSync(file, "utf8")).toBe("bar(42)");
});

test.each(["content", "plan"])("native AST rechecks %s changes during the shared handler preview", async (change) => {
  const f = await fake();
  const file = join(f.a, "source.ts");
  writeFileSync(file, "foo(42)");
  f.agents.set("ses_a", "build");
  const args = { pattern: "foo($A)", rewrite: "bar($A)", lang: "typescript", paths: ["source.ts"] };
  await f.call("ast_replace", args);
  let changedDuringPreview = false;
  f.onProgress((update) => {
    if (!changedDuringPreview && update.status === "ast-grep running") {
      changedDuringPreview = true;
      if (change === "content") writeFileSync(file, "foo(99)");
      else f.agents.set("ses_a", "plan");
    }
  });
  await expect(f.call("ast_replace", { ...args, dry_run: false })).rejects.toThrow(change === "content" ? "AST input changed during preview" : "switched to the plan agent");
  expect(changedDuringPreview).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(change === "content" ? "foo(99)" : "foo(42)");
  expect(f.changes).toEqual([]);
});

test("native tools honor cancellation before filesystem work", async () => {
  const f = await fake();
  const abort = new AbortController();
  abort.abort(new Error("stopped"));
  await expect(f.call("evidence_log", evidence, "ses_a", "build", "call_abort", abort.signal)).rejects.toThrow("stopped");
  expect(existsSync(join(f.a, ".omca"))).toBe(false);
  expect(f.assertions).toHaveLength(0);
});

test("native AST refuses symlink escapes and ignored dependency trees", async () => {
  const f = await fake();
  writeFileSync(join(f.b, "outside.ts"), "foo(1)");
  symlinkSync(join(f.b, "outside.ts"), join(f.a, "linked.ts"));
  await expect(f.call("ast_search", { pattern: "foo($A)", lang: "typescript", paths: ["linked.ts"] })).rejects.toThrow("symlinks");
  mkdirSync(join(f.a, "node_modules"));
  writeFileSync(join(f.a, "node_modules", "dep.ts"), "foo(1)");
  await expect(f.call("ast_search", { pattern: "foo($A)", lang: "typescript", paths: ["node_modules/dep.ts"] })).rejects.toThrow("node_modules");
});

test.each([".break", ".d", ".d/owner", ".break.d", ".break.d/owner"])("owned lock sidecar %s cannot be redirected through a symlink", async (suffix) => {
  for (const name of ["evidence_log", "notepad_write"]) {
    const f = await fake();
    const path = name === "evidence_log" ? ledger(f.a) : section(f.a);
    const sidecar = `${path}.lock${suffix}`;
    const target = suffix.endsWith(".d") ? f.b : join(f.b, "target");
    if (!suffix.endsWith(".d")) writeFileSync(target, "outside must stay unchanged");
    mkdirSync(dirname(sidecar), { recursive: true });
    symlinkSync(target, sidecar, suffix.endsWith(".d") ? "dir" : "file");
    await expect(f.call(name, name === "evidence_log" ? evidence : note)).rejects.toThrow("symlinks");
    expect(existsSync(path)).toBe(false);
    if (!suffix.endsWith(".d")) expect(readFileSync(target, "utf8")).toBe("outside must stay unchanged");
  }
});
