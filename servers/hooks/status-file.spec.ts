import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dispatch } from "./registry.ts";
import { ledgerPath, STAMP_INTERVAL_MS, statusPath } from "./status-file.ts";

const NOW = 1_786_000_000_000;
const NOW_S = NOW / 1000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-status-"));
  roots.push(root);
  return root;
}

const status = (root: string, sessionId: string) => JSON.parse(readFileSync(statusPath(root, sessionId), "utf8"));
const stop = (root: string, sessionId: string, now: number) => dispatch({ event: "Stop", session_id: sessionId }, root, now);

describe("hook stamp", () => {
  test("the first hook call of a session writes last_hook_at with no verification", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await stop(root, sessionId, NOW);
    expect(status(root, sessionId)).toEqual({ session_id: sessionId, last_hook_at: NOW_S, verification: null });
    expect(readdirSync(dirname(statusPath(root, sessionId)))).toEqual([`${sessionId}.json`]);
  });

  test("last_hook_at is stamped at most once per 5 s per session", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    const stamps = [];
    for (const offset of [0, 1_000, STAMP_INTERVAL_MS - 1, STAMP_INTERVAL_MS, STAMP_INTERVAL_MS + 4_000, 2 * STAMP_INTERVAL_MS]) {
      await stop(root, sessionId, NOW + offset);
      stamps.push(status(root, sessionId).last_hook_at);
    }
    expect(stamps).toEqual([NOW_S, NOW_S, NOW_S, NOW_S + 5, NOW_S + 5, NOW_S + 10]);
  });

  test("each session keeps its own throttle and its own file", async () => {
    const root = project();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await stop(root, first, NOW);
    await stop(root, second, NOW + 1_000);
    expect([status(root, first).last_hook_at, status(root, second).last_hook_at]).toEqual([NOW_S, NOW_S + 1]);
  });

  test("a call without a session id writes nothing", async () => {
    const root = project();
    await dispatch({ event: "Stop" }, root, NOW);
    expect(readdirSync(root)).toEqual([]);
  });

  test("a recorder update rewrites the file at once and restarts the throttle", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await stop(root, sessionId, NOW);
    const bash = { event: "PostToolUse", session_id: sessionId, tool_name: "Bash", tool_input: { command: "just test" } };
    await dispatch(bash, root, NOW + 2_000);
    await stop(root, sessionId, NOW + 6_000);
    expect(status(root, sessionId)).toEqual({
      session_id: sessionId,
      last_hook_at: NOW_S + 2,
      verification: { command: "just test", at: NOW_S + 2, exit_code: null, evidence_logged: false },
    });
  });

  test("evidence_logged turns true on the next stamp once the ledger postdates the verification", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await dispatch({ event: "PostToolUse", session_id: sessionId, tool_name: "Bash", tool_input: { command: "just test" } }, root, NOW);
    mkdirSync(dirname(ledgerPath(root)), { recursive: true });
    writeFileSync(ledgerPath(root), '{"entries":[]}');
    utimesSync(ledgerPath(root), NOW_S + 3, NOW_S + 3);
    await stop(root, sessionId, NOW + STAMP_INTERVAL_MS);
    expect(status(root, sessionId).verification).toEqual({ command: "just test", at: NOW_S, exit_code: null, evidence_logged: true });
  });

  test("a failed stamp is logged and the hook answer still stands", async () => {
    const root = project();
    writeFileSync(join(root, ".omca"), "a file where the state directory belongs");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const deny = {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" },
      };
      const registry = { PreToolUse: [["guard", () => deny]] as const };
      const sessionId = crypto.randomUUID();
      expect(await dispatch({ event: "PreToolUse", session_id: sessionId }, root, NOW, registry)).toEqual(deny);
      expect(errors.mock.calls[0]?.[0]).toBe(`omca: could not stamp the status file for session ${sessionId}:`);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("session id validation", () => {
  test("a UUID and the fixture ids map to a file under .omca/state/session", () => {
    const id = crypto.randomUUID();
    expect(statusPath("/p", id)).toBe(`/p/.omca/state/session/${id}.json`);
    expect(statusPath("/p", "fixture-sid-001")).toBe("/p/.omca/state/session/fixture-sid-001.json");
  });

  test.each(["", "..", "../escape", "a/b", "a\0b", ".hidden", "a.json", "x".repeat(129)])("rejects %p before it reaches a path", (id) => {
    expect(() => statusPath("/p", id)).toThrow("unsafe session id in a state path");
  });

  test("an unsafe session id on a hook call writes nothing and is reported", async () => {
    const root = project();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await stop(root, "../../etc/x", NOW)).toEqual({});
      expect(errors.mock.calls).toEqual([['omca: ignoring hook session state for an unsafe session id "../../etc/x"']]);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
