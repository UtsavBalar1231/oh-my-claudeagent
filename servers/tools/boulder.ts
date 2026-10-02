import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asRegistry, type PlanEntry, type Registry, resolveBoundPlan } from "../../src/core/boulder.ts";
import { checkboxStates, nextTaskLabel, planIsComplete } from "../../src/core/checkboxes.ts";
import { latestSessionId } from "../hooks/session-state.ts";
import { ensureStateDir, projectRoot, withLock, writeFileAtomic } from "../io.ts";
import type { Tool } from "../omca.ts";

export const GC_MAX_AGE_SECONDS = 7 * 24 * 3600;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export type PruneSummary = { pruned_plans: string[]; pruned_bindings: string[] };

const bound = new Map<string, Set<string>>();
/** Project root to the session ids `boulder_write` bound there in this process, for the exit handler to unbind. */
export const boundSessionsByRoot: ReadonlyMap<string, ReadonlySet<string>> = bound;

const WORKING_DIRECTORY = { type: "string", default: "", description: "Project root (auto-detected from git)" };

function stringArg(args: Record<string, unknown>, tool: string, name: string, fallback?: string): string {
  const value = args[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${tool}: ${name} must be a string`);
  return value;
}

const sessionIdOr = (sessionId: string): string =>
  sessionId || (latestSessionId() ?? process.env.CLAUDE_CODE_SESSION_ID ?? "");

const rootOf = (workingDirectory: string): string => projectRoot(workingDirectory || process.cwd());
const registryPath = (root: string): string => join(root, ".omca", "state", "boulder.json");

function readRaw(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const writeRegistry = (path: string, registry: Registry): void =>
  writeFileAtomic(path, `${JSON.stringify({ plans: registry.plans, bindings: registry.bindings }, null, 2)}\n`);

function planFileIsComplete(path: string | undefined): boolean {
  if (!path) return false;
  try {
    return planIsComplete(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

const isoSeconds = (iso: unknown): number => {
  const ms = typeof iso === "string" && ISO_SECONDS.test(iso) ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms / 1000;
};

const boundNames = (registry: Registry): Set<string | undefined> =>
  new Set(Object.values(registry.bindings).map((binding) => binding.plan_name));

/**
 * Write-path GC, in place: drops bindings older than 7 days, then unbound plans that are
 * complete and started more than 7 days ago.
 */
export function pruneStale(registry: Registry, nowSeconds: number): void {
  for (const [sessionId, { bound_at }] of Object.entries(registry.bindings)) {
    if (typeof bound_at === "number" && nowSeconds - bound_at > GC_MAX_AGE_SECONDS) delete registry.bindings[sessionId];
  }
  const names = boundNames(registry);
  for (const [name, entry] of Object.entries(registry.plans)) {
    if (names.has(name) || nowSeconds - isoSeconds(entry.started_at) <= GC_MAX_AGE_SECONDS) continue;
    if (planFileIsComplete(entry.active_plan)) delete registry.plans[name];
  }
}

/**
 * Start-time GC, in place: drops bindings to plans that no longer exist, then every unbound
 * plan that is complete, missing its file, or missing `active_plan`. An incomplete plan with a
 * live file is resumable work and always kept.
 */
export function pruneUnbound(registry: Registry): PruneSummary {
  const pruned_bindings = Object.entries(registry.bindings)
    .filter(([, binding]) => binding.plan_name === undefined || !Object.hasOwn(registry.plans, binding.plan_name))
    .map(([sessionId]) => sessionId);
  for (const sessionId of pruned_bindings) delete registry.bindings[sessionId];
  const names = boundNames(registry);
  const pruned_plans = Object.entries(registry.plans)
    .filter(([name, { active_plan }]) => !names.has(name) && (!active_plan || !existsSync(active_plan) || planFileIsComplete(active_plan)))
    .map(([name]) => name);
  for (const name of pruned_plans) delete registry.plans[name];
  return { pruned_plans, pruned_bindings };
}

/** Runs `pruneUnbound` on the project's registry under its lock, writing only when something was pruned. */
export async function gcRegistry(root: string): Promise<PruneSummary> {
  const path = registryPath(root);
  if (!existsSync(path)) return { pruned_plans: [], pruned_bindings: [] };
  return withLock(`${path}.lock`, () => {
    const registry = asRegistry(readRaw(path));
    const summary = pruneUnbound(registry);
    if (summary.pruned_plans.length > 0 || summary.pruned_bindings.length > 0) writeRegistry(path, registry);
    return summary;
  });
}

// Object.fromEntries defines keys as own data properties, so a name like `__proto__` is stored
// rather than swallowed by the prototype setter, and an existing key keeps its position.
const withKey = <T>(record: Record<string, T>, key: string, value: T): Record<string, T> =>
  Object.fromEntries([...Object.entries(record), [key, value]]);

async function boulderWrite(args: Record<string, unknown>): Promise<string> {
  const activePlan = stringArg(args, "boulder_write", "active_plan");
  const planName = stringArg(args, "boulder_write", "plan_name");
  const sessionId = sessionIdOr(stringArg(args, "boulder_write", "session_id"));
  const agent = stringArg(args, "boulder_write", "agent", "sisyphus");
  const worktreePath = stringArg(args, "boulder_write", "worktree_path", "");
  const root = rootOf(stringArg(args, "boulder_write", "working_directory", ""));
  const path = join(ensureStateDir(root), "boulder.json");

  const sessions = await withLock(`${path}.lock`, () => {
    const registry = asRegistry(readRaw(path));
    const existing: PlanEntry = Object.hasOwn(registry.plans, planName) ? (registry.plans[planName] as PlanEntry) : {};
    const sessionIds = Array.isArray(existing.session_ids) ? [...existing.session_ids] : [];
    if (sessionId && !sessionIds.includes(sessionId)) sessionIds.push(sessionId);
    const worktree = worktreePath || existing.worktree_path || "";
    const entry: PlanEntry = {
      active_plan: activePlan,
      started_at: existing.started_at || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      session_ids: sessionIds,
      agent: agent || existing.agent || "sisyphus",
      ...(worktree && { worktree_path: worktree }),
    };
    registry.plans = withKey(registry.plans, planName, entry);
    if (sessionId) {
      registry.bindings = withKey(registry.bindings, sessionId, { plan_name: planName, bound_at: Math.floor(Date.now() / 1000) });
    }
    pruneStale(registry, Date.now() / 1000);
    writeRegistry(path, registry);
    return sessionIds.length;
  });
  if (sessionId) bound.set(root, (bound.get(root) ?? new Set()).add(sessionId));
  return `Boulder state written: plan=${planName}, sessions=${sessions}`;
}

function boulderProgress(args: Record<string, unknown>): string {
  let planPath = stringArg(args, "boulder_progress", "plan_path", "");
  const planName = stringArg(args, "boulder_progress", "plan_name", "");
  const sessionId = stringArg(args, "boulder_progress", "session_id", "");
  const workingDirectory = stringArg(args, "boulder_progress", "working_directory", "");
  if (!planPath) {
    const raw = readRaw(registryPath(rootOf(workingDirectory)));
    if (planName) {
      const { plans } = asRegistry(raw);
      planPath = (Object.hasOwn(plans, planName) && plans[planName]?.active_plan) || "";
    } else {
      planPath = resolveBoundPlan(raw, sessionIdOr(sessionId)).active_plan ?? "";
    }
    if (!planPath) return "No active plan found in boulder state.";
  }

  let content: string;
  try {
    content = readFileSync(planPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const missing = { error: true, plan_missing: true, plan_path: planPath, message: `Plan file not found: ${planPath}.` };
    return JSON.stringify(missing, null, 2);
  }
  const states = checkboxStates(content);
  const completed = states.filter((state) => state === "x").length;
  return JSON.stringify(
    {
      total: states.length,
      completed,
      remaining: states.length - completed,
      is_complete: planIsComplete(content),
      plan_path: planPath,
      next_task_label: nextTaskLabel(content),
    },
    null,
    2,
  );
}

export const tools: Tool[] = [
  {
    name: "boulder_write",
    description:
      "Register a work plan in the project's plan registry (.omca/state/boulder.json) and bind this session to it. Upserts plans[plan_name], keeping its started_at and adding session_id to its session_ids, then prunes bindings older than 7 days and unbound, finished plans of that age. Binding turns on plan enforcement for this session: while numbered tasks (`- [ ] N.`) remain unchecked, the Stop hook blocks the stop with a nudge to continue, and once all are checked it blocks until a final_verification evidence entry matches the plan. Call it once before executing a plan; calling it again is safe. Returns a confirmation with the plan name and session count.",
    inputSchema: {
      type: "object",
      properties: {
        active_plan: { type: "string", description: "Absolute path to the plan file" },
        plan_name: { type: "string", description: "Short name for the plan" },
        session_id: {
          type: "string",
          description:
            "This session's platform UUID, as shown in the SessionStart context ('Session <id> initialized'). An empty string uses the session of the most recent OMCA hook call, or the server's CLAUDE_CODE_SESSION_ID before any hook has run. Any other value binds a session that does not exist, and the Stop hooks will not see the plan.",
        },
        agent: { type: "string", default: "sisyphus", description: "Agent managing this plan" },
        worktree_path: { type: "string", default: "", description: "Git worktree path if using worktrees" },
        working_directory: WORKING_DIRECTORY,
      },
      required: ["active_plan", "plan_name", "session_id"],
    },
    annotations: {
      title: "Register work plan",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { "anthropic/searchHint": "register the active work plan and bind this session to it" },
    call: boulderWrite,
  },
  {
    name: "boulder_progress",
    description:
      "Count a plan file's numbered checkboxes (`- [ ] N.` and `- [x] N.`; unnumbered boxes are ignored) and return progress. Use to report plan status or to find the next task. With plan_path, reads that file. Otherwise it looks up plan_name in the registry, or else this session's binding; a session with no binding falls back to the only registered plan, or to the most recently started one, which may belong to another session, so pass plan_name or plan_path when several plans exist. Returns JSON with total, completed, remaining, is_complete, plan_path, and next_task_label (the first unchecked task, truncated to 80 chars, or null when none remain); a JSON error object with plan_missing when the plan file is gone; or a plain message when no plan resolves.",
    inputSchema: {
      type: "object",
      properties: {
        plan_path: { type: "string", default: "", description: "Path to plan file (resolves from boulder registry if empty)" },
        plan_name: {
          type: "string",
          default: "",
          description: "Named plan in the registry to check (bypasses session resolution)",
        },
        session_id: {
          type: "string",
          default: "",
          description: "Session ID used to resolve the bound plan when plan_path/plan_name are omitted",
        },
        working_directory: WORKING_DIRECTORY,
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: {
      "anthropic/searchHint": "plan task progress: completed and remaining checkboxes, plus the next task label",
      "anthropic/alwaysLoad": true,
    },
    call: boulderProgress,
  },
];
