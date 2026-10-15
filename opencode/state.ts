import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readRegistryDocument, resolveBoundPlan, type Registry, type RegistryDocument, unbindSessions, upsertPlanSession } from "../src/core/boulder.ts";
import { outsideFences, planTasks } from "../src/core/checkboxes.ts";
import { entriesOf, readLedger, type Evidence } from "../src/core/evidence.ts";
import { NOTEPAD_SECTIONS, parseEntries, toPlanName } from "../src/core/notepad.ts";
import { BOULDER, LEDGER } from "../src/core/omca-paths.ts";
import { boardOf, parsePlan } from "../src/core/plan-reader.ts";
import { STATE_VERSION } from "../src/core/state-version.ts";
import { isRecord } from "../src/core/tool-input.ts";
import { redact } from "../src/core/visual.ts";
import { hasCode, projectRoot, withLock, writeFileAtomic } from "../servers/io.ts";
import { isoTimestamp } from "../servers/tools/args.ts";

export interface Snapshot {
  sessionID: string;
  directory: string;
  plan: null | {
    name: string;
    path: string;
    sha256: string;
    status: string;
    tasks: Array<{ number: number; label: string; checked: boolean; dependencies: number[] }>;
  };
  evidence: {
    entries: Array<{ type: string; command: string; exitCode: number; at: number; snippet: string; verifiedBy: string | null; planSha: string }>;
    verdict: "missing" | "historical" | "stale" | "verified";
  };
  notepads: Array<{ section: string; content: string }>;
  health: Array<{ name: string; state: "ok" | "warning" | "error"; detail: string }>;
}

export type BoundPlan = { name: string; path: string; worktreePath: string };
/** Native registry, ledger, and per-section notepad input ceiling; oversized files are refused. */
export const STATE_FILE_BYTE_LIMIT = 4 * 1024 * 1024;
/** Native plan input ceiling, checked before allocating its read buffer or parsing Markdown. */
export const PLAN_FILE_BYTE_LIMIT = 1024 * 1024;
/** Bounds admitted task count and recursive dependency traversal depth. */
export const PLAN_TASK_LIMIT = 1_000;
const NOTE_LIMIT = 8_000;
const EVIDENCE_LIMIT = 50;

function sessionKey(sessionID: string): string {
  if (sessionID.trim() === "" || /[\r\n\0]/.test(sessionID)) throw new Error("A native session ID is required");
  return `opencode:${sessionID}`;
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Dangling symlinks are not allowed");
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonical(parent), basename(path));
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

const rootOf = (directory: string): string => realpathSync.native(projectRoot(resolve(directory)));
const registryPath = (root: string): string => join(root, BOULDER);

function contained(path: string, roots: readonly string[]): string {
  if (!roots.some((root) => inside(root, path))) throw new Error("Path is outside the allowed checkout or plan directory");
  const actual = canonical(path);
  if (!roots.some((root) => inside(root, path) && inside(root, actual))) throw new Error("Path escapes its allowed directory through a symlink");
  return actual;
}

function checkLock(root: string, path: string): void {
  for (const lock of [path, `${path}.break`]) {
    contained(lock, [root]);
    contained(join(`${lock}.d`, "owner"), [root]);
  }
}

function planPath(root: string, path: string): string {
  const home = realpathSync.native(homedir());
  const expanded = path.startsWith("~/") ? join(home, path.slice(2)) : path;
  const actual = contained(resolve(root, expanded), [root, join(home, ".opencode", "plan")]);
  if (!actual.endsWith(".md")) throw new Error("A plan must be a local Markdown file");
  return actual;
}

function readBoundedFile(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Expected a regular file");
    if (stat.size > limit) throw new Error(`File exceeds the ${limit}-byte native read limit`);
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > stat.size) throw new Error("File grew during inspection; refresh before reading it");
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

export function planDigest(path: string): string {
  return createHash("sha256").update(readBoundedFile(path, PLAN_FILE_BYTE_LIMIT)).digest("hex");
}

function readLocal(root: string, path: string): Buffer | null {
  const actual = contained(path, [root]);
  if (actual !== resolve(path)) throw new Error("OMCA state paths must not contain symlinks");
  try {
    return readBoundedFile(actual, STATE_FILE_BYTE_LIMIT);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function readRegistry(root: string): RegistryDocument | null {
  const bytes = readLocal(root, registryPath(root));
  if (bytes === null) return null;
  const parsed = readRegistryDocument(bytes.toString("utf8"));
  if (parsed.kind === "refused") throw new Error(`Registry cannot be read: ${parsed.reason}`);
  return parsed;
}

function resolveBinding(root: string, sessionID: string, file: RegistryDocument | null): BoundPlan | null {
  const key = sessionKey(sessionID);
  if (file === null || !Object.hasOwn(file.registry.bindings, key)) return null;
  const binding = file.registry.bindings[key];
  if (!isRecord(binding) || typeof binding.plan_name !== "string") throw new Error("Invalid native session binding");
  const name = toPlanName(binding.plan_name);
  if (!Object.hasOwn(file.registry.plans, name)) throw new Error("The bound plan is missing from the registry");
  const entry = file.registry.plans[name];
  if (!isRecord(entry) || typeof entry.active_plan !== "string" || entry.active_plan === "") throw new Error("The bound plan has no valid file path");
  const bound = resolveBoundPlan(file.registry, key, true);
  if (bound === undefined) throw new Error("The native session binding cannot be resolved");
  return { name, path: planPath(root, bound.active_plan), worktreePath: typeof bound.worktree_path === "string" ? bound.worktree_path : "" };
}

export function boundPlan(directory: string, sessionID: string): BoundPlan | null {
  const root = rootOf(directory);
  return resolveBinding(root, sessionID, readRegistry(root));
}

function checkExpectedBinding(binding: BoundPlan | null, expectedPlan?: BoundPlan | null): void {
  if (expectedPlan !== undefined && (binding?.name !== expectedPlan?.name || binding?.path !== expectedPlan?.path || binding?.worktreePath !== expectedPlan?.worktreePath)) {
    throw new Error("Plan binding changed during inspection; refresh before reading it");
  }
}

/** Reads no ledger or notepads. Only an unbound session returns null; invalid bound state throws. */
export function readBoundPlan(directory: string, sessionID: string, expectedPlan?: BoundPlan | null): Snapshot["plan"] {
  sessionKey(sessionID);
  const root = rootOf(directory);
  const binding = resolveBinding(root, sessionID, readRegistry(root));
  checkExpectedBinding(binding, expectedPlan);
  return binding === null ? null : readPlan(binding.path, binding.name);
}

function readPlan(path: string, name: string): NonNullable<Snapshot["plan"]> {
  const bytes = readBoundedFile(path, PLAN_FILE_BYTE_LIMIT);
  const source = outsideFences(bytes.toString("utf8"));
  const numbered = planTasks(source);
  if (numbered.length > PLAN_TASK_LIMIT) throw new Error(`Plan exceeds the ${PLAN_TASK_LIMIT}-task native read limit`);
  const preamble = source.split("\n").slice(0, numbered[0]?.line).join("\n");
  const statuses = [...preamble.matchAll(/^\s*(?:-\s+)?(?:\*\*)?Status(?:\*\*)?\s*:\s*(.*?)\s*$/gim)].map((match) => (match[1] ?? "").replace(/\*/g, "").trim().toUpperCase());
  if (statuses.length !== 1 || statuses[0] !== "FINAL") throw new Error("Plan Status must be FINAL, not DRAFT, missing, or unknown");
  if (numbered.length === 0) throw new Error("Plan must contain numbered tasks");
  const known = new Set<number>();
  for (const task of numbered) {
    if (!Number.isSafeInteger(task.number) || task.number <= 0) throw new Error("Task numbers must be positive safe integers");
    if (known.has(task.number)) throw new Error(`Duplicate task number ${task.number}`);
    known.add(task.number);
  }
  const board = boardOf(parsePlan(source));
  const tasks = numbered.map(({ line: _line, ...task }, index) => {
    const fields = board.cards[index]?.fields ?? [];
    const dependencies = fields.filter((field) => ["depends", "depends on"].includes(field.name.toLowerCase())).flatMap((field) => {
      const text = field.text.replace(/`/g, "").trim();
      if (/^(?:none|n\/a|-|—)?$/i.test(text)) return [];
      if (!/^(?:task\s+)?#?\d+(?:\s*,\s*(?:task\s+)?#?\d+)*$/i.test(text)) throw new Error(`Invalid dependencies for task ${task.number}`);
      return (text.match(/\d+/g) ?? []).map(Number);
    });
    if (dependencies.some((dependency) => dependency === task.number || !known.has(dependency))) throw new Error(`Invalid dependency reference for task ${task.number}`);
    return { ...task, dependencies: [...new Set(dependencies)] };
  });
  const graph = new Map(tasks.map((task) => [task.number, task.dependencies]));
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (number: number): void => {
    if (visiting.has(number)) throw new Error("Plan dependencies contain a cycle");
    if (visited.has(number)) return;
    visiting.add(number);
    for (const dependency of graph.get(number) ?? []) visit(dependency);
    visiting.delete(number);
    visited.add(number);
  };
  for (const task of tasks) visit(task.number);
  return { name, path, sha256: createHash("sha256").update(bytes).digest("hex"), status: "FINAL", tasks };
}

function evidenceVerdict(entries: Evidence[], plan: Snapshot["plan"]): Snapshot["evidence"]["verdict"] {
  if (plan === null) return "missing";
  const finals = entries.filter((entry) => entry.type === "final_verification" && entry.planSha !== "");
  const latest = finals.findLast((entry) => entry.planSha === plan.sha256);
  if (latest === undefined) return finals.length === 0 ? "missing" : "stale";
  if (latest.exitCode !== 0) return "stale";
  const lastFinal = entries.lastIndexOf(latest);
  if (entries.slice(lastFinal + 1).some((entry) => entry.exitCode !== 0 && (entry.planSha === "" || entry.planSha === plan.sha256))) return "stale";
  return "historical";
}

export function readSnapshot(directory: string, sessionID: string, expectedPlan?: BoundPlan | null): Snapshot {
  const snapshot: Snapshot = {
    directory, sessionID, plan: null, evidence: { entries: [], verdict: "missing" }, notepads: [],
    health: [{ name: "verification", state: "warning", detail: "Native server-authored verification provenance is not supported yet; ledger successes are historical, not verified." }],
  };
  const report = (name: string, state: Snapshot["health"][number]["state"], detail: string): void => { snapshot.health.push({ name, state, detail: redact(detail, homedir(), "<masked>").text }); };
  let root: string;
  try {
    sessionKey(sessionID);
    root = rootOf(directory);
  } catch (error) {
    report("context", "error", String(error));
    return snapshot;
  }
  let binding: BoundPlan | null = null;
  try {
    const registry = readRegistry(root);
    const resolved = resolveBinding(root, sessionID, registry);
    checkExpectedBinding(resolved, expectedPlan);
    binding = resolved;
    report("registry", registry === null ? "warning" : "ok", registry === null ? "Registry is missing" : "Registry is readable");
    report("binding", binding === null ? "warning" : "ok", binding === null ? "This native session has no bound plan" : "Plan is explicitly bound to this native session");
  } catch (error) {
    report("registry", "error", String(error));
  }
  if (binding !== null) {
    try {
      snapshot.plan = readPlan(binding.path, binding.name);
      report("plan", "ok", "Plan status, numbered tasks, and dependencies are valid");
    } catch (error) {
      report("plan", "error", String(error));
    }
    for (const section of NOTEPAD_SECTIONS) {
      try {
        const bytes = readLocal(root, join(root, ".omca", "notepads", binding.name, `${section}.md`));
        if (bytes === null) continue;
        const entries = parseEntries(bytes.toString("utf8"));
        const text = entries.map((entry) => `${entry.at === null ? "" : `## ${new Date(entry.at).toISOString()}\n\n`}${entry.text}`).join("\n\n");
        const content = redact(text, homedir(), "<masked>").text;
        snapshot.notepads.push({ section, content: content.slice(-NOTE_LIMIT) });
        if (content.length > NOTE_LIMIT) report(`notepad:${section}`, "warning", "Older notepad content was omitted from this snapshot");
      } catch (error) {
        report(`notepad:${section}`, "error", String(error));
      }
    }
  }
  try {
    const bytes = readLocal(root, join(root, LEDGER));
    if (bytes === null) report("ledger", "warning", "Evidence ledger is missing");
    else {
      const ledger = readLedger(bytes.toString("utf8"));
      if (ledger.kind === "refused") throw new Error(`Evidence ledger cannot be read: ${ledger.reason}`);
      const raw = entriesOf(ledger.document);
      const malformed = raw === undefined || raw.length !== ledger.entries.length;
      report("ledger", malformed ? "warning" : "ok", malformed ? "Evidence entries are missing or malformed; unreadable entries were omitted" : "Evidence ledger is readable");
      snapshot.evidence.verdict = evidenceVerdict(ledger.entries, snapshot.plan);
      snapshot.evidence.entries = ledger.entries.slice(-EVIDENCE_LIMIT).map((entry) => ({
        ...entry,
        command: redact(entry.command, homedir(), "<masked>").text.slice(0, 2_000),
        snippet: redact(entry.snippet, homedir(), "<masked>").text.slice(0, 2_000),
        verifiedBy: entry.verifiedBy === null ? null : redact(entry.verifiedBy, homedir(), "<masked>").text.slice(0, 200),
      }));
    }
  } catch (error) {
    report("ledger", "error", String(error));
  }
  return snapshot;
}

export async function bindPlan(directory: string, sessionID: string, path: string, beforeWrite?: () => Promise<void>): Promise<void> {
  const key = sessionKey(sessionID);
  const root = rootOf(directory);
  const actual = planPath(root, path);
  const name = toPlanName(basename(actual, ".md"));
  readPlan(actual, name);
  const registry = registryPath(root);
  contained(registry, [root]);
  checkLock(root, `${registry}.lock`);
  await withLock(`${registry}.lock`, async () => {
    if (beforeWrite) await beforeWrite();
    contained(registry, [root]);
    const file = readRegistry(root);
    const plans: Registry["plans"] = file?.registry.plans ?? {};
    const bindings: Registry["bindings"] = file?.registry.bindings ?? {};
    const existing = Object.hasOwn(plans, name) ? plans[name] : undefined;
    const fields = {
      active_plan: actual,
      started_at: existing?.started_at ?? isoTimestamp(),
      worktree_path: existing?.worktree_path ?? root,
    };
    if (existing !== undefined && !isRecord(existing)) throw new Error("Existing plan entry is malformed");
    if (existing?.active_plan !== undefined && (typeof existing.active_plan !== "string" || planPath(root, existing.active_plan) !== actual)) throw new Error("A different plan already uses this plan name");
    if (existing?.session_ids !== undefined && !Array.isArray(existing.session_ids)) throw new Error("Existing plan session_ids is malformed");
    const binding = Object.hasOwn(bindings, key) ? bindings[key] : undefined;
    if (binding !== undefined && !isRecord(binding)) throw new Error("Existing native session binding is malformed");
    readPlan(planPath(root, actual), name);
    const updated = upsertPlanSession({ plans, bindings }, name, fields, key, Math.floor(Date.now() / 1000));
    writeFileAtomic(registry, `${JSON.stringify({ version: STATE_VERSION, ...file?.document, ...updated }, null, 2)}\n`);
  });
}

export async function unbindPlan(directory: string, sessionID: string, beforeWrite?: () => Promise<void>): Promise<void> {
  const key = sessionKey(sessionID);
  const root = rootOf(directory);
  const registry = registryPath(root);
  const initial = readRegistry(root);
  if (initial === null || !Object.hasOwn(initial.registry.bindings, key)) return;
  checkLock(root, `${registry}.lock`);
  await withLock(`${registry}.lock`, async () => {
    if (beforeWrite) await beforeWrite();
    const file = readRegistry(root);
    if (file === null || !Object.hasOwn(file.registry.bindings, key)) return;
    const { bindings } = unbindSessions(file.registry, [key]);
    writeFileAtomic(registry, `${JSON.stringify({ version: STATE_VERSION, ...file.document, bindings }, null, 2)}\n`);
  });
}
