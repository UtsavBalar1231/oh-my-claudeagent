import type { Verification } from "../../src/core/verification.ts";

export type Session = {
  readonly id: string;
  stampedAt?: number;
  verification?: Verification;
  isGuided?: boolean;
  isTitleChecked?: boolean;
  promptAt?: number;
  injectedContext?: Set<string>;
  announcedModes?: Set<string>;
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
