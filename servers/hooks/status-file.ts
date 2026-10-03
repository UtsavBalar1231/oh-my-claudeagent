import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { asRegistry, resolveBoundPlan } from "../../src/core/boulder.ts";
import { ledgerCoversSlot } from "../../src/core/evidence.ts";
import { BOULDER, LEDGER, statusPath as sessionStatusPath } from "../../src/core/omca-paths.ts";
import { isSafeId } from "../../src/core/session-id.ts";
import { isRecord } from "../../src/core/tool-input.ts";
import { errorCode, hasCode, isMissing, writeFileAtomic } from "../io.ts";
import type { Session } from "./session-state.ts";

export const STAMP_INTERVAL_MS = 5_000;

export function statusPath(root: string, sessionId: string): string {
  const path = sessionStatusPath(root, sessionId);
  if (path === undefined) throw new Error(`unsafe session id in a state path: ${JSON.stringify(sessionId)}`);
  return join(path);
}

export const ledgerPath = (root: string): string => join(root, LEDGER);
export const registryPath = (root: string): string => join(root, BOULDER);

/** The mod's marker for the session, or undefined when the id cannot name a file or the mod never wrote one. */
export function readMarker(root: string, sessionId: string): Record<string, unknown> | undefined {
  if (!isSafeId(sessionId)) return undefined;
  let text: string;
  try {
    text = readFileSync(join(root, ".omca", "state", "mod", `${sessionId}.json`), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const marker: unknown = JSON.parse(text);
  return isRecord(marker) ? marker : undefined;
}

/** When the mod last marked the session, or undefined when it never has. */
export function markerWrittenAt(root: string, sessionId: string): number | undefined {
  const at = readMarker(root, sessionId)?.written_at;
  return typeof at === "number" ? at : undefined;
}

type Unreadable = { kind: "unreadable"; path: string; code: string };
export type RegistryRead = { kind: "absent" } | { kind: "corrupt" } | Unreadable | { kind: "ok"; data: unknown };
export type PlanFile = { bytes: Buffer; content: string };
export type BoundPlanRead =
  | Exclude<RegistryRead, { kind: "ok" }>
  | { kind: "unbound" }
  | { kind: "ok"; name: string; path: string; boundAt: unknown; file: PlanFile | undefined };

const unreadable = (path: string, error: unknown): Unreadable => ({ kind: "unreadable", path, code: errorCode(error) ?? String(error) });

/** The plan registry. Only text that does not parse is corrupt; a parsed value without the registry shape reads as an empty registry. */
export function readRegistry(root: string): RegistryRead {
  const path = registryPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return isMissing(error) ? { kind: "absent" } : unreadable(path, error);
  }
  try {
    return { kind: "ok", data: JSON.parse(text) };
  } catch {
    return { kind: "corrupt" };
  }
}

/**
 * The plan this session is explicitly bound to, with its file. `file` is undefined when the plan
 * file is missing; any other error reading it is `unreadable`.
 */
export function readBoundPlan(root: string, sessionId: string, registry = readRegistry(root)): BoundPlanRead {
  if (registry.kind !== "ok") return registry;
  const plan = resolveBoundPlan(registry.data, sessionId, true);
  if (plan === undefined || !("plan_name" in plan)) return { kind: "unbound" };
  const path = resolve(root, plan.active_plan);
  const bound = { kind: "ok", name: plan.plan_name, path: plan.active_plan, boundAt: asRegistry(registry.data).bindings[sessionId]?.bound_at } as const;
  try {
    const bytes = readFileSync(path);
    return { ...bound, file: { bytes, content: bytes.toString("utf8") } };
  } catch (error) {
    return isMissing(error) ? { ...bound, file: undefined } : unreadable(path, error);
  }
}

export const seconds = (ms: number): number => Math.floor(ms / 1000);

export function ledgerMtimeSeconds(root: string): number {
  try {
    return seconds(statSync(ledgerPath(root)).mtimeMs);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return 0;
    throw error;
  }
}

export function writeStatus(root: string, session: Session, now: number): void {
  const { verification } = session;
  const status = {
    session_id: session.id,
    last_hook_at: seconds(now),
    verification:
      verification === undefined
        ? null
        : { ...verification, evidence_logged: ledgerCoversSlot(ledgerMtimeSeconds(root), verification.at) },
  };
  writeFileAtomic(statusPath(root, session.id), `${JSON.stringify(status)}\n`);
  session.stampedAt = now;
}

export function stampIfDue(root: string, session: Session, now: number): void {
  if (session.stampedAt === undefined || now - session.stampedAt >= STAMP_INTERVAL_MS) writeStatus(root, session, now);
}
