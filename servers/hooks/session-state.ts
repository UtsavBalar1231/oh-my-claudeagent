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

export function touchSession(id: string): Session {
  const session = sessions.get(id) ?? { id };
  sessions.delete(id);
  sessions.set(id, session);
  for (const oldest of sessions.keys()) {
    if (sessions.size <= MAX_SESSIONS) break;
    sessions.delete(oldest);
  }
  return session;
}
