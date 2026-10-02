import { expect, test } from "bun:test";
import { latestSessionId, MAX_SESSIONS, touchSession } from "./session-state.ts";

test("the latest session id is the one the most recent hook call touched", () => {
  const before = crypto.randomUUID();
  const after = crypto.randomUUID();
  touchSession(before);
  touchSession(after);
  expect(latestSessionId()).toBe(after);
  touchSession(before);
  expect(latestSessionId()).toBe(before);
});

test("the same id returns the same session", () => {
  const id = crypto.randomUUID();
  expect(touchSession(id)).toBe(touchSession(id));
  expect(touchSession(id).id).toBe(id);
});

test("above 32 sessions the oldest-touched session is dropped first", () => {
  expect(MAX_SESSIONS).toBe(32);
  const kept = touchSession(crypto.randomUUID());
  kept.verification = { command: "just test", at: 1, exit_code: null };
  const oldest = touchSession(crypto.randomUUID());
  for (let i = 0; i < MAX_SESSIONS - 2; i++) touchSession(crypto.randomUUID());
  expect(touchSession(kept.id)).toBe(kept);
  touchSession(crypto.randomUUID());
  expect(touchSession(kept.id).verification).toEqual({ command: "just test", at: 1, exit_code: null });
  expect(touchSession(oldest.id)).not.toBe(oldest);
});
