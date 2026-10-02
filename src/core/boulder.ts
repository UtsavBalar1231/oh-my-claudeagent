export interface PlanEntry {
  active_plan?: string;
  started_at?: string;
  session_ids?: string[];
  agent?: string;
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

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyRegistry(): Registry {
  return { plans: {}, bindings: {} };
}

// The old single-plan file: a top-level `active_plan` and no registry keys.
function migrateFlat(data: Dict): Registry {
  const name = data["plan_name"];
  if (typeof name !== "string" || name === "") return emptyRegistry();
  const entry: PlanEntry = {
    active_plan: (data["active_plan"] as string | undefined) ?? "",
    started_at: (data["started_at"] as string | undefined) ?? "",
    session_ids: [...((data["session_ids"] as string[] | undefined) ?? [])],
    agent: (data["agent"] as string | undefined) ?? "sisyphus",
  };
  const worktree = data["worktree_path"];
  if (typeof worktree === "string" && worktree !== "") entry.worktree_path = worktree;
  return { plans: { [name]: entry }, bindings: {} };
}

/** Registry-shaped view of parsed boulder.json. Pure: the file is never rewritten. */
export function normalize(data: unknown): Registry {
  if (!isDict(data)) return emptyRegistry();
  if (Object.hasOwn(data, "active_plan") && !Object.hasOwn(data, "plans")) {
    return migrateFlat(data);
  }
  const { plans, bindings } = data;
  return {
    plans: isDict(plans) ? (plans as Registry["plans"]) : {},
    bindings: isDict(bindings) ? (bindings as Registry["bindings"]) : {},
  };
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
 * (first wins a tie), else `{}`. Strict: only an explicit binding to a plan that
 * still exists resolves, so an unbound session never inherits another's plan.
 */
export function resolveBoundPlan(
  data: unknown,
  sessionId: string,
  strict = false,
): BoundPlan | Record<string, never> {
  const { plans, bindings } = normalize(data);

  const name = sessionId ? bindings[sessionId]?.plan_name : undefined;
  if (name !== undefined && Object.hasOwn(plans, name)) {
    return boundPlan(name, plans[name] as PlanEntry);
  }
  if (strict) return {};

  let latest: string | undefined;
  let latestAt = "";
  for (const [name, entry] of Object.entries(plans)) {
    const startedAt = entry.started_at ?? "";
    if (latest === undefined || startedAt > latestAt) {
      latest = name;
      latestAt = startedAt;
    }
  }
  return latest === undefined ? {} : boundPlan(latest, plans[latest] as PlanEntry);
}
