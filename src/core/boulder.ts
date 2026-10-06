import { parseDocument, type Refusal, refuse } from "./state-version.ts";
import { isRecord } from "./tool-input.ts";

export interface PlanEntry {
  active_plan?: string;
  started_at?: string;
  session_ids?: string[];
  worktree_path?: string;
}

export interface Binding {
  plan_name?: string;
  bound_at?: number;
}

export interface Registry {
  plans: Record<string, PlanEntry>;
  bindings: Record<string, Binding>;
}

export interface BoundPlan {
  plan_name: string;
  active_plan: string;
  worktree_path: string;
}

function emptyRegistry(): Registry {
  return { plans: {}, bindings: {} };
}

/** Registry view of parsed boulder.json: a `plans` or `bindings` that is not an object reads as empty. */
export function asRegistry(data: unknown): Registry {
  if (!isRecord(data)) return emptyRegistry();
  const { plans, bindings } = data;
  return {
    plans: isRecord(plans) ? (plans as Registry["plans"]) : {},
    bindings: isRecord(bindings) ? (bindings as Registry["bindings"]) : {},
  };
}

export type RegistryParse = { kind: "ok"; registry: Registry } | Refusal;

/**
 * The one reader of registry text. Refused: text that is not JSON, not an object, or whose
 * `plans` or `bindings` is present and not an object, or whose `version` is not 1. A writer must
 * not replace a refused file; a reader treats it as an empty registry.
 */
export function parseRegistry(text: string): RegistryParse {
  const parsed = parseDocument(text);
  if (parsed.kind === "refused") return parsed;
  const { plans, bindings } = parsed.document;
  if ((plans !== undefined && !isRecord(plans)) || (bindings !== undefined && !isRecord(bindings))) {
    return refuse("shape", "its `plans` or `bindings` is not an object");
  }
  return { kind: "ok", registry: asRegistry(parsed.document) };
}

function boundPlan(name: string, entry: PlanEntry): BoundPlan {
  return {
    plan_name: name,
    active_plan: entry.active_plan ?? "",
    worktree_path: entry.worktree_path ?? "",
  };
}

/**
 * Lenient: explicit binding, else the sole plan, else the latest `started_at`
 * (first wins a tie), else undefined. Strict: only an explicit binding to a plan that
 * still exists resolves, so an unbound session never inherits another's plan.
 */
export function resolveBoundPlan(
  data: unknown,
  sessionId: string,
  strict = false,
): BoundPlan | undefined {
  const { plans, bindings } = asRegistry(data);

  const name = sessionId ? bindings[sessionId]?.plan_name : undefined;
  if (name !== undefined && Object.hasOwn(plans, name)) {
    return boundPlan(name, plans[name] as PlanEntry);
  }
  if (strict) return undefined;

  let latest: string | undefined;
  let latestAt = "";
  for (const [name, entry] of Object.entries(plans)) {
    const startedAt = entry.started_at ?? "";
    if (latest === undefined || startedAt > latestAt) {
      latest = name;
      latestAt = startedAt;
    }
  }
  return latest === undefined ? undefined : boundPlan(latest, plans[latest] as PlanEntry);
}
