import { statSync } from "node:fs";
import { join } from "node:path";
import { ledgerCoversSlot } from "../../src/core/evidence.ts";
import { BOULDER, LEDGER, statusPath as sessionStatusPath } from "../../src/core/omca-paths.ts";
import { hasCode, writeFileAtomic } from "../io.ts";
import type { Session } from "./session-state.ts";

export const STAMP_INTERVAL_MS = 5_000;

export function statusPath(root: string, sessionId: string): string {
  const path = sessionStatusPath(root, sessionId);
  if (path === undefined) throw new Error(`unsafe session id in a state path: ${JSON.stringify(sessionId)}`);
  return join(path);
}

export const ledgerPath = (root: string): string => join(root, LEDGER);
export const registryPath = (root: string): string => join(root, BOULDER);

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
