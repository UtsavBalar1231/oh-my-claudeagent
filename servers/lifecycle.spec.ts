import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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
    .map((entry) => relative(base, join(entry.parentPath, entry.name)))
    .sort();
}

const read = (root: string, path: string): string => readFileSync(join(root, path), "utf8");

const entry = (i: number) => ({ type: "test", command: `run ${i}`, exit_code: 0, output_snippet: "ok", timestamp: "2026-10-01T00:00:00Z" });

function seedDurable(root: string): { registry: string; ledger: string } {
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
  return { registry, ledger };
}

describe("start-up work", () => {
  test("the server that serves the model's tools prunes the plan registry and rotates the evidence ledger", async () => {
    const root = project();
    seedDurable(root);
    await startWork(root, true, NOW);
    expect(JSON.parse(read(root, ".omca/state/boulder.json"))).toEqual({
      plans: { live: { active_plan: join(root, "live.md"), started_at: "2026-10-01T00:00:00Z", session_ids: ["s1"] } },
      bindings: { s1: { plan_name: "live", bound_at: 1_786_000_000 } },
    });
    const live = JSON.parse(read(root, ".omca/evidence/verification-evidence.json")).entries;
    const archived = JSON.parse(read(root, ".omca/evidence/verification-evidence.202610.json")).entries;
    expect([live.length, live[0].command, archived.length, archived.at(-1).command]).toEqual([500, "run 501", 501, "run 500"]);
  });

  test("the hooks-only server leaves the plan registry and the evidence ledger byte-identical", async () => {
    const root = project();
    const { registry, ledger } = seedDurable(root);
    await startWork(root, false, NOW);
    expect(read(root, ".omca/state/boulder.json")).toBe(registry);
    expect(files(root, ".omca/evidence")).toEqual(["verification-evidence.json"]);
    expect(read(root, ".omca/evidence/verification-evidence.json")).toBe(ledger);
  });

  test("delegation records and feedback files older than 90 days go, newer ones stay, and an emptied record directory goes", async () => {
    const root = project();
    put(root, ".omca/metrics/s-old/a1.json", "{}", 91 * DAY_MS);
    put(root, ".omca/metrics/s-mixed/a2.json", "{}", 91 * DAY_MS);
    put(root, ".omca/metrics/s-mixed/a3.json", "{}", 89 * DAY_MS);
    put(root, ".omca/feedback/s-old.json", "{}", 91 * DAY_MS);
    put(root, ".omca/feedback/s-new.json", "{}", 89 * DAY_MS);
    await startWork(root, false, NOW);
    expect(readdirSync(join(root, ".omca", "metrics"))).toEqual(["s-mixed"]);
    expect(files(root, ".omca/metrics")).toEqual(["s-mixed/a3.json"]);
    expect(files(root, ".omca/feedback")).toEqual(["s-new.json"]);
  });

  test("mod markers and session status files older than 24 hours go and newer ones stay", async () => {
    const root = project();
    for (const dir of ["mod", "session"]) {
      put(root, `.omca/state/${dir}/old.json`, "{}", 25 * HOUR_MS);
      put(root, `.omca/state/${dir}/new.json`, "{}", 23 * HOUR_MS);
      put(root, `.omca/state/${dir}/old.json.tmp`, "{}", 25 * HOUR_MS);
    }
    await startWork(root, false, NOW);
    expect(files(root, ".omca/state/mod")).toEqual(["new.json", "old.json.tmp"]);
    expect(files(root, ".omca/state/session")).toEqual(["new.json", "old.json.tmp"]);
  });

  test("a step that fails is logged and the steps after it still run", async () => {
    const root = project();
    put(root, ".omca/evidence/verification-evidence.json", "{not json");
    put(root, ".omca/state/mod/old.json", "{}", 25 * HOUR_MS);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await startWork(root, true, NOW);
      expect(errors.mock.calls.map(([message]) => message)).toEqual(["omca: start-up evidence ledger rotation failed:"]);
    } finally {
      errors.mockRestore();
    }
    expect(read(root, ".omca/evidence/verification-evidence.json")).toBe("{not json");
    expect(files(root, ".omca/state/mod")).toEqual([]);
  });
});
