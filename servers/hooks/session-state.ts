import type { DenyOnce } from "../../src/core/comments.ts";
import type { ErrorCount } from "../../src/core/error-counts.ts";
import type { Backoff, StopLedger } from "../../src/core/stop-ledger.ts";
import type { Verification } from "../../src/core/verification.ts";

/** The key of the main conversation's slot: a hook firing there carries no agent_id. */
export const MAIN_THREAD = "";

/** The agent a hook fired in, keyed as `verifications` keys it. The client sends an absent agent_id as "". */
export const agentKey = (agentId: unknown): string => (typeof agentId === "string" ? agentId : MAIN_THREAD);

export type Session = {
  readonly id: string;
  stampedAt?: number;
  verifications?: Map<string, Verification>;
  isGuided?: boolean;
  isTitleChecked?: boolean;
  isModChecked?: boolean;
  promptAt?: number;
  compactedAt?: number;
  injectedContext?: Set<string>;
  announcedModes?: Set<string>;
  commentGate?: DenyOnce;
  errorCounts?: Map<string, ErrorCount>;
  stopBlocks?: StopLedger;
  hasTouchedTask?: boolean;
  runBackoff?: { run: string; backoff: Backoff };
};

export const MAX_SESSIONS = 32;

// Map iteration follows insertion order, so re-inserting on every touch keeps the
// oldest-touched session first.
const sessions = new Map<string, Session>();

// `/clear` keeps this process, and its CLAUDE_CODE_SESSION_ID keeps naming the old session, so a
// model-called tool that needs the session takes the id the latest hook call carried.
let latest: string | undefined;

export const latestSessionId = (): string | undefined => latest;

export const findSession = (id: string): Session | undefined => sessions.get(id);

export function touchSession(id: string): Session {
  latest = id;
  const session = sessions.get(id) ?? { id };
  sessions.delete(id);
  sessions.set(id, session);
  for (const oldest of sessions.keys()) {
    if (sessions.size <= MAX_SESSIONS) break;
    sessions.delete(oldest);
  }
  return session;
}

/** True the first time `mode` is announced in the session; a call without a session cannot remember. */
export function announceOnce(session: Session | undefined, mode: string): boolean {
  if (session === undefined) return true;
  const modes = (session.announcedModes ??= new Set());
  if (modes.has(mode)) return false;
  modes.add(mode);
  return true;
}
