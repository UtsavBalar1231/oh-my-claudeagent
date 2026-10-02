import { isSafeSessionId } from "./session-id.ts";

export const BOULDER = ".omca/state/boulder.json";
export const LEDGER = ".omca/evidence/verification-evidence.json";

/** The session's status file, or undefined when the id cannot name a file under `.omca/state/`. */
export const statusPath = (root: string, sessionId: string): string | undefined =>
  isSafeSessionId(sessionId) ? `${root}/.omca/state/session/${sessionId}.json` : undefined;

export function verificationOf(status: unknown): { command: string; at: number } | null {
  if (typeof status !== "object" || status === null || !("verification" in status)) return null;
  const { verification } = status;
  if (typeof verification !== "object" || verification === null) return null;
  if (!("command" in verification) || !("at" in verification)) return null;
  const { command, at } = verification;
  return typeof command === "string" && typeof at === "number" ? { command, at } : null;
}
