import type { Verification } from "../../src/core/verification.ts";

export type Session = {
  readonly id: string;
  stampedAt?: number;
  verification?: Verification;
};

export const MAX_SESSIONS = 32;

// Map iteration follows insertion order, so re-inserting on every touch keeps the
// oldest-touched session first.
const sessions = new Map<string, Session>();

// `/clear` keeps this process, and its CLAUDE_CODE_SESSION_ID keeps naming the old session, so a
// model-called tool that needs the session takes the id the latest hook call carried.
let latest: string | undefined;

export const latestSessionId = (): string | undefined => latest;

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
