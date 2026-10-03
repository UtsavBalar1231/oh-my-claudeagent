import { describe, expect, test } from "bun:test";
import { ago, parseRuns, proofOf, proofSummary, type Run } from "./proof.ts";

const T = Date.UTC(2026, 9, 2, 12, 0, 0);
const MIN = 60_000;

const run = (type: Run["type"], exitCode: number, at: number, command = `just ${type}`): Run => ({
  type,
  command,
  exitCode,
  at,
  snippet: "",
  verifiedBy: null,
});

describe("parseRuns", () => {
  test("keeps well-formed entries, oldest first, with their optional fields defaulted", () => {
    const text = JSON.stringify({
      entries: [
        { type: "test", command: "just test", exit_code: 1, output_snippet: "2 fail", timestamp: "2026-10-02T12:10:00Z", verified_by: "executor" },
        { type: "build", command: "bun run build", exit_code: 0, timestamp: "2026-10-02T12:00:00Z", verified_by: "" },
        { type: "deploy", command: "x", exit_code: 0, timestamp: "2026-10-02T12:00:00Z" },
        { type: "lint", command: "just lint", exit_code: "0", timestamp: "2026-10-02T12:00:00Z" },
        { type: "lint", command: "just lint", exit_code: 0, timestamp: "yesterday" },
        null,
      ],
    });
    expect(parseRuns(text)).toEqual([
      { type: "build", command: "bun run build", exitCode: 0, at: T, snippet: "", verifiedBy: null },
      { type: "test", command: "just test", exitCode: 1, at: T + 10 * MIN, snippet: "2 fail", verifiedBy: "executor" },
    ]);
  });

  test("refuses a file that is not a ledger", () => {
    expect(() => parseRuns("{}")).toThrow("it holds no entries list");
    expect(() => parseRuns("not json")).toThrow();
  });
});

describe("proofOf", () => {
  const files = [T - 30 * MIN, T - 10 * MIN];

  test("a task with no files has no proof", () => {
    expect(proofOf([], [run("test", 0, T)])).toBeUndefined();
  });

  test("PROVEN when a passing test, build or lint run is newer than every file", () => {
    const pass = run("build", 0, T);
    expect(proofOf(files, [run("test", 0, T - 20 * MIN), pass])).toEqual({
      proof: "proven",
      changedAt: T - 10 * MIN,
      since: [pass],
      lastPass: pass,
    });
  });

  test("UNPROVEN when a file changed after the last passing run", () => {
    const pass = run("test", 0, T - 20 * MIN);
    expect(proofOf(files, [pass])).toEqual({ proof: "unproven", changedAt: T - 10 * MIN, since: [], lastPass: pass });
  });

  test("UNPROVEN when nothing ever ran", () => {
    expect(proofOf(files, [])).toEqual({ proof: "unproven", changedAt: T - 10 * MIN, since: [], lastPass: undefined });
  });

  test("FAILED when the newest run after the last change failed, even after a pass", () => {
    const pass = run("test", 0, T - 5 * MIN);
    const fail = run("lint", 2, T);
    expect(proofOf(files, [fail, pass])).toEqual({ proof: "failed", changedAt: T - 10 * MIN, since: [fail, pass], lastPass: pass });
  });

  test("a pass after a failure proves the task again", () => {
    const fail = run("test", 1, T - 5 * MIN);
    const pass = run("test", 0, T);
    expect(proofOf(files, [fail, pass])?.proof).toBe("proven");
  });

  test("manual and final verification runs neither prove nor fail a task", () => {
    expect(proofOf(files, [run("manual", 0, T), run("final_verification", 1, T)])).toEqual({
      proof: "unproven",
      changedAt: T - 10 * MIN,
      since: [],
      lastPass: undefined,
    });
  });

  test("a run at the same instant as the change does not prove it", () => {
    expect(proofOf([T], [run("test", 0, T)])?.proof).toBe("unproven");
  });
});

test("proofSummary counts each verdict and skips tasks without one", () => {
  expect(proofSummary(["proven", "proven", "unproven", undefined, "failed", "proven"])).toEqual({ proven: 3, unproven: 1, failed: 1 });
  expect(proofSummary([])).toEqual({ proven: 0, unproven: 0, failed: 0 });
});

test("ago reads elapsed time at the coarsest useful unit", () => {
  expect([0, 4_999, 5_000, 59_999, MIN, 59 * MIN, 60 * MIN, 47 * 60 * MIN, 48 * 60 * MIN, -1].map(ago)).toEqual([
    "now",
    "now",
    "5s",
    "59s",
    "1m",
    "59m",
    "1h",
    "47h",
    "2d",
    "now",
  ]);
});
