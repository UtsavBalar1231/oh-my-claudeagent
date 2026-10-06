import { isSafeId } from "./session-id.ts";
import { isRecord } from "./tool-input.ts";

export const BOULDER = ".omca/state/boulder.json";
export const LEDGER = ".omca/evidence/verification-evidence.json";

/** The session's status file, or undefined when the id cannot name a file under `.omca/state/`. */
export const statusPath = (root: string, sessionId: string): string | undefined =>
  isSafeId(sessionId) ? `${root}/.omca/state/session/${sessionId}.json` : undefined;

export function verificationOf(status: unknown): { command: string; at: number } | null {
  const verification = isRecord(status) ? status["verification"] : undefined;
  if (!isRecord(verification)) return null;
  const { command, at } = verification;
  return typeof command === "string" && typeof at === "number" ? { command, at } : null;
}

export function exitCodeOf(status: unknown): number | null {
  const verification = isRecord(status) ? status["verification"] : undefined;
  const code = isRecord(verification) ? verification["exit_code"] : undefined;
  return typeof code === "number" ? code : null;
}
