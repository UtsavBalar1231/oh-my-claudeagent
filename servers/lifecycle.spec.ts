import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { startWork } from "./lifecycle.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omca-lifecycle-")));
  roots.push(root);
  return root;
}

function put(root: string, path: string, text: string, ageMs = 0): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const at = (NOW - ageMs) / 1000;
  utimesSync(file, at, at);
}

function files(root: string, dir: string): string[] {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(base, join(entry.parentPath, entry.name)).replaceAll(sep, "/"))
    .sort();
}

const read = (root: string, path: string): string => readFileSync(join(root, path), "utf8");

const entry = (i: number) => ({ type: "test", command: `run ${i}`, exit_code: 0, output_snippet: "ok", timestamp: "2026-10-01T00:00:00Z" });

function seedDurable(root: string): void {
  put(root, "done.md", "- [x] 1. one\n");
  put(root, "live.md", "- [ ] 1. one\n");
  const registry = JSON.stringify({
    plans: {
      done: { active_plan: join(root, "done.md"), started_at: "2026-10-01T00:00:00Z", session_ids: [] },
      live: { active_plan: join(root, "live.md"), started_at: "2026-10-01T00:00:00Z", session_ids: ["s1"] },
    },
    bindings: { s1: { plan_name: "live", bound_at: 1_786_000_000 } },
  });
  const ledger = JSON.stringify({ entries: Array.from({ length: 1001 }, (_, i) => entry(i)) });
  put(root, ".omca/state/boulder.json", registry);
  put(root, ".omca/evidence/verification-evidence.json", ledger);
}

describe("start-up work", () => {
  test("the server prunes the plan registry and rotates the evidence ledger", async () => {
    const root = project();
    seedDurable(root);
    await startWork(root, NOW);
    expect(JSON.parse(read(root, ".omca/state/boulder.json"))).toEqual({
      version: 1,
      plans: { live: { active_plan: join(root, "live.md"), started_at: "2026-10-01T00:00:00Z", session_ids: ["s1"] } },
      bindings: { s1: { plan_name: "live", bound_at: 1_786_000_000 } },
    });
    const live = JSON.parse(read(root, ".omca/evidence/verification-evidence.json")).entries;
    const archived = JSON.parse(read(root, ".omca/evidence/verification-evidence.202610.json")).entries;
    expect([live.length, live[0].command, archived.length, archived.at(-1).command]).toEqual([500, "run 501", 501, "run 500"]);
  });

  test("delegation records and feedback files older than 90 days go, newer ones stay, and an emptied record directory goes", async () => {
    const root = project();
    put(root, ".omca/metrics/s-old/a1.json", "{}", 91 * DAY_MS);
    put(root, ".omca/metrics/s-mixed/a2.json", "{}", 91 * DAY_MS);
    put(root, ".omca/metrics/s-mixed/a3.json", "{}", 89 * DAY_MS);
    put(root, ".omca/feedback/s-old.json", "{}", 91 * DAY_MS);
    put(root, ".omca/feedback/s-new.json", "{}", 89 * DAY_MS);
    await startWork(root, NOW);
    expect(readdirSync(join(root, ".omca", "metrics"))).toEqual(["s-mixed"]);
    expect(files(root, ".omca/metrics")).toEqual(["s-mixed/a3.json"]);
    expect(files(root, ".omca/feedback")).toEqual(["s-new.json"]);
  });

  test("mod markers and session status files older than 24 hours go and newer ones stay", async () => {
    const root = project();
    for (const dir of ["mod", "session"]) {
      put(root, `.omca/state/${dir}/old.json`, "{}", 25 * HOUR_MS);
      put(root, `.omca/state/${dir}/new.json`, "{}", 23 * HOUR_MS);
      put(root, `.omca/state/${dir}/old.json.bak`, "{}", 25 * HOUR_MS);
    }
    await startWork(root, NOW);
    expect(files(root, ".omca/state/mod")).toEqual(["new.json", "old.json.bak"]);
    expect(files(root, ".omca/state/session")).toEqual(["new.json", "old.json.bak"]);
  });

  test("temp files a crash left under state, evidence and notepads go after 24 hours, and no directory is removed", async () => {
    const root = project();
    const old = [
      ".omca/state/boulder.json.1111.tmp",
      ".omca/state/boulder.json.lock.2222.tmp",
      ".omca/state/session/s1.json.3333.tmp",
      ".omca/evidence/verification-evidence.json.4444.tmp",
      ".omca/notepads/plan-a/learnings.md.5555.tmp",
    ];
    for (const path of old) put(root, path, "partial", 25 * HOUR_MS);
    put(root, ".omca/state/boulder.json.6666.tmp", "partial", 23 * HOUR_MS);
    put(root, ".omca/notepads/plan-a/learnings.md", "kept", 25 * HOUR_MS);
    mkdirSync(join(root, ".omca", "state", "boulder.json.lock.d"));
    await startWork(root, NOW);
    expect(files(root, ".omca/state")).toEqual(["boulder.json.6666.tmp"]);
    expect(files(root, ".omca/evidence")).toEqual([]);
    expect(files(root, ".omca/notepads")).toEqual(["plan-a/learnings.md"]);
    expect(existsSync(join(root, ".omca", "state", "boulder.json.lock.d"))).toBe(true);
  });

  test("a file that cannot be removed is logged and the entries after it are still pruned", async () => {
    const root = project();
    for (const name of ["a", "b", "c"]) put(root, `.omca/state/mod/${name}.json`, "{}", 25 * HOUR_MS);
    put(root, ".omca/metrics/s-1/locked.json", "{}", 91 * DAY_MS);
    put(root, ".omca/metrics/s-1/free.json", "{}", 91 * DAY_MS);
    const real = fs.rmSync;
    const remove = spyOn(fs, "rmSync").mockImplementation((path, options) => {
      if (String(path).endsWith("b.json") || String(path).endsWith("locked.json")) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      real(path, options);
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await startWork(root, NOW);
      expect(errors.mock.calls.map(([message]) => message)).toEqual([
        `omca: start-up prune left ${join(root, ".omca/metrics/s-1/locked.json")}:`,
        `omca: start-up prune left ${join(root, ".omca/state/mod/b.json")}:`,
      ]);
    } finally {
      remove.mockRestore();
      errors.mockRestore();
    }
    expect(files(root, ".omca/state/mod")).toEqual(["b.json"]);
    expect(files(root, ".omca/metrics")).toEqual(["s-1/locked.json"]);
  });

  test("a step that fails is logged and the steps after it still run", async () => {
    const root = project();
    put(root, ".omca/evidence/verification-evidence.json", "{not json");
    put(root, ".omca/state/mod/old.json", "{}", 25 * HOUR_MS);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await startWork(root, NOW);
      expect(errors.mock.calls.map(([message]) => message)).toEqual(["omca: start-up evidence ledger rotation failed:"]);
    } finally {
      errors.mockRestore();
    }
    expect(read(root, ".omca/evidence/verification-evidence.json")).toBe("{not json");
    expect(files(root, ".omca/state/mod")).toEqual([]);
  });
});
