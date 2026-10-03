import { describe, expect, test } from "bun:test";
import {
  clockOf,
  dayLabel,
  dayOf,
  type Evidence,
  EVIDENCE_TYPES,
  isSlotRecent,
  isWellFormedLedger,
  ledgerCoversSlot,
  MAX_SLOT_AGE_SECONDS,
  MTIME_SLACK_SECONDS,
  parseLedger,
  placeEntries,
  recentLevels,
  rerunPrompt,
  sha256Hex,
  shownIndices,
  tallies,
  verdictOf,
} from "./evidence.ts";

const entry = {
  type: "test",
  command: "just ci",
  exit_code: 0,
  output_snippet: "10 passed",
  timestamp: "2026-10-02T12:05:00Z",
};

test("evidence types are the five the ledger accepts", () => {
  expect([...EVIDENCE_TYPES]).toEqual(["build", "test", "lint", "manual", "final_verification"]);
});

describe("isSlotRecent", () => {
  test("a verification exactly at the age limit is still recent", () => {
    expect(isSlotRecent(10_000 + MAX_SLOT_AGE_SECONDS, 10_000)).toBe(true);
  });

  test("a verification one second past the age limit is not recent", () => {
    expect(isSlotRecent(10_000 + MAX_SLOT_AGE_SECONDS + 1, 10_000)).toBe(false);
  });

  test("a verification that just finished is recent", () => {
    expect(isSlotRecent(10_000, 10_000)).toBe(true);
  });
});

describe("ledgerCoversSlot", () => {
  test("a ledger written in the same second as the verification covers it", () => {
    expect(ledgerCoversSlot(500, 500)).toBe(true);
  });

  test("a ledger written after the verification covers it", () => {
    expect(ledgerCoversSlot(501, 500)).toBe(true);
  });

  test("a ledger last written within the mtime slack before the verification still covers it", () => {
    expect(MTIME_SLACK_SECONDS).toBe(2);
    expect(ledgerCoversSlot(499, 500)).toBe(true);
    expect(ledgerCoversSlot(498, 500)).toBe(true);
  });

  test("a ledger last written more than the slack before the verification does not cover it", () => {
    expect(ledgerCoversSlot(497, 500)).toBe(false);
  });

  test("a missing ledger, treated as mtime 0, does not cover a real verification", () => {
    expect(ledgerCoversSlot(0, 1_786_000_000)).toBe(false);
  });
});

describe("isWellFormedLedger", () => {
  test("accepts a ledger of complete entries", () => {
    const optional = { ...entry, type: "final_verification", verified_by: "x", plan_sha256: "ab" };
    expect(isWellFormedLedger({ entries: [entry, optional] })).toBe(true);
  });

  test("accepts a non-zero exit_code and an empty-string command", () => {
    expect(isWellFormedLedger({ entries: [{ ...entry, exit_code: 1, command: "" }] })).toBe(true);
  });

  test.each(["type", "command", "exit_code", "output_snippet", "timestamp"])(
    "rejects an entry missing %s",
    (field) => {
      const { [field]: _dropped, ...partial } = entry as Record<string, unknown>;
      expect(isWellFormedLedger({ entries: [partial] })).toBe(false);
    },
  );

  test("rejects an entry whose exit_code is null", () => {
    expect(isWellFormedLedger({ entries: [{ ...entry, exit_code: null }] })).toBe(false);
  });

  test("rejects one bad entry among good ones", () => {
    expect(isWellFormedLedger({ entries: [entry, { type: "test" }, entry] })).toBe(false);
  });

  test.each([
    ["an empty entries list", { entries: [] }],
    ["entries that is not an array", { entries: {} }],
    ["no entries key", {}],
    ["null", null],
    ["an array", [entry]],
    ["a null entry", { entries: [null] }],
    ["a string entry", { entries: ["test"] }],
  ])("rejects %s", (_label, data) => {
    expect(isWellFormedLedger(data)).toBe(false);
  });
});

const at = (iso: string) => Date.parse(iso);

const run = (overrides: Partial<Evidence>): Evidence => ({
  type: "test",
  command: "just test",
  exitCode: 0,
  at: at("2026-10-02T12:00:00Z"),
  snippet: "",
  verifiedBy: "executor",
  planSha: "",
  ...overrides,
});

describe("parseLedger", () => {
  test("reads every well-formed entry in file order and skips the rest", () => {
    const text = JSON.stringify({
      entries: [
        { ...entry, verified_by: "oh-my-claudeagent:executor" },
        { type: "deploy", command: "x", exit_code: 0, timestamp: "2026-10-02T12:06:00Z" },
        { type: "lint", command: "just lint", exit_code: "0", timestamp: "2026-10-02T12:07:00Z" },
        { type: "lint", command: "just lint", exit_code: 0, timestamp: "not a time" },
        null,
        { type: "final_verification", command: "just ci", exit_code: 1, timestamp: "2026-10-02T12:08:00Z", verified_by: "", plan_sha256: "ab" },
      ],
    });
    expect(parseLedger(text)).toEqual([
      {
        type: "test",
        command: "just ci",
        exitCode: 0,
        at: at("2026-10-02T12:05:00Z"),
        snippet: "10 passed",
        verifiedBy: "oh-my-claudeagent:executor",
        planSha: "",
      },
      { type: "final_verification", command: "just ci", exitCode: 1, at: at("2026-10-02T12:08:00Z"), snippet: "", verifiedBy: null, planSha: "ab" },
    ]);
  });

  test("an empty entries list reads as no entries", () => {
    expect(parseLedger('{"entries":[]}')).toEqual([]);
  });

  test("a ledger without an entries list, or that is not JSON, throws", () => {
    expect(() => parseLedger('{"items":[]}')).toThrow("it holds no entries list");
    expect(() => parseLedger("{")).toThrow(SyntaxError);
  });
});

describe("verdictOf", () => {
  const SHA = "a".repeat(64);
  const final = (exitCode: number, planSha: string, iso: string) => run({ type: "final_verification", exitCode, planSha, at: at(iso) });

  test("a passing final verification scoped to the plan's bytes is complete", () => {
    const proof = final(0, SHA, "2026-10-02T11:00:00Z");
    expect(verdictOf([proof, run({})], SHA)).toEqual({ kind: "complete", entry: proof });
  });

  test("a passing final verification with no scope matches any plan, as the Stop gate reads it", () => {
    const proof = final(0, "", "2026-10-02T11:00:00Z");
    expect(verdictOf([proof], SHA)).toEqual({ kind: "complete", entry: proof });
  });

  test("one scoped to other bytes is stale, and the newest such entry is named", () => {
    const older = final(0, "b".repeat(64), "2026-10-02T09:00:00Z");
    const newer = final(0, "c".repeat(64), "2026-10-02T10:00:00Z");
    expect(verdictOf([older, newer], SHA)).toEqual({ kind: "stale", entry: newer });
  });

  test("a matching pass anywhere in the ledger wins over a newer stale one", () => {
    const proof = final(0, SHA, "2026-10-02T09:00:00Z");
    expect(verdictOf([proof, final(0, "c".repeat(64), "2026-10-02T10:00:00Z")], SHA)).toEqual({ kind: "complete", entry: proof });
  });

  test("only failing final verifications are missing, naming the newest failure", () => {
    const failed = final(1, SHA, "2026-10-02T10:00:00Z");
    expect(verdictOf([final(2, SHA, "2026-10-02T09:00:00Z"), failed], SHA)).toEqual({ kind: "missing", failed });
  });

  test("no final verification at all is missing with nothing failed", () => {
    expect(verdictOf([run({})], SHA)).toEqual({ kind: "missing", failed: null });
  });
});

test("tallies count runs and failures per type in ledger type order, leaving out types never run", () => {
  const entries = [run({ type: "lint" }), run({ exitCode: 1 }), run({}), run({ type: "build", exitCode: 2 }), run({ type: "lint" })];
  expect(tallies(entries)).toEqual([
    { type: "build", runs: 1, failed: 1 },
    { type: "test", runs: 2, failed: 1 },
    { type: "lint", runs: 2, failed: 0 },
  ]);
});

test("recentLevels keeps the last runs oldest first, a non-zero exit failing", () => {
  const entries = [run({ exitCode: 1 }), run({}), run({ exitCode: 127 }), run({})];
  expect(recentLevels(entries, 3)).toEqual(["ok", "fail", "ok"]);
  expect(recentLevels([], 30)).toEqual([]);
});

describe("shownIndices", () => {
  const entries = [
    run({ type: "build", command: "bun run build" }),
    run({ command: "just test-mod", exitCode: 1, verifiedBy: "oh-my-claudeagent:explore" }),
    run({ command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://ci.test" }),
    run({ type: "lint", command: "just lint", exitCode: 1 }),
  ];
  const none = { type: null, isFailuresOnly: false, query: "" };

  test("no filter keeps every entry, newest first", () => {
    expect(shownIndices(entries, none, "/home/u")).toEqual([3, 2, 1, 0]);
  });

  test("a type, failures only, and both together", () => {
    expect(shownIndices(entries, { ...none, type: "test" }, "/home/u")).toEqual([2, 1]);
    expect(shownIndices(entries, { ...none, isFailuresOnly: true }, "/home/u")).toEqual([3, 1]);
    expect(shownIndices(entries, { ...none, type: "test", isFailuresOnly: true }, "/home/u")).toEqual([1]);
  });

  test("a query matches the command, the agent or the type label, ignoring case and outer spaces", () => {
    expect(shownIndices(entries, { ...none, query: " JUST " }, "/home/u")).toEqual([3, 1]);
    expect(shownIndices(entries, { ...none, query: "explore" }, "/home/u")).toEqual([1]);
    expect(shownIndices(entries, { ...none, query: "build" }, "/home/u")).toEqual([0]);
  });

  test("a query never matches the text a mask hides", () => {
    expect(shownIndices(entries, { ...none, query: "abcdefghijklmnop" }, "/home/u")).toEqual([]);
    expect(shownIndices(entries, { ...none, query: "bearer ‹masked›" }, "/home/u")).toEqual([2]);
  });
});

test("days and clocks read in local time", () => {
  const local = new Date(2026, 9, 2, 9, 5, 7).getTime();
  expect(dayOf(local)).toBe("2026-10-02");
  expect(dayLabel(local)).toBe("Fri 2026-10-02");
  expect(clockOf(local)).toBe("09:05");
  expect(clockOf(local, true)).toBe("09:05:07");
});

describe("placeEntries", () => {
  const ones = (count: number) => Array.from({ length: count }, () => 1);
  const opens = (count: number, at: readonly number[] = [0]) => Array.from({ length: count }, (_, index) => at.includes(index));

  test("a list that fits starts at its first entry", () => {
    expect(placeEntries([2, 1, 1], opens(3), 0, 1, 10)).toEqual({ start: 0, end: 3 });
  });

  test("the window keeps its start while the focus is inside it", () => {
    expect(placeEntries(ones(20), opens(20), 4, 6, 5)).toEqual({ start: 4, end: 8 });
  });

  test("a focus below the window moves it the least, counting the heading of a window opened mid-day", () => {
    expect(placeEntries(ones(20), opens(20), 0, 9, 5)).toEqual({ start: 6, end: 10 });
  });

  test("a focus above the window starts the window on it", () => {
    expect(placeEntries(ones(20), opens(20), 10, 3, 5)).toEqual({ start: 3, end: 7 });
  });

  test("a window opened on a day's first entry spends no extra row on the heading", () => {
    expect(placeEntries([1, 1, 1, 2, 1, 1, 1], opens(7, [0, 3]), 0, 4, 4)).toEqual({ start: 3, end: 6 });
  });

  test("an opened entry taller than the room still shows, alone", () => {
    expect(placeEntries([1, 9, 1], opens(3), 0, 1, 4)).toEqual({ start: 1, end: 2 });
  });

  test("the window never leaves rows empty below the last entry", () => {
    expect(placeEntries(ones(10), opens(10), 9, 9, 5)).toEqual({ start: 6, end: 10 });
  });

  test("no entries is an empty window", () => {
    expect(placeEntries([], [], 3, 0, 5)).toEqual({ start: 0, end: 0 });
  });
});

describe("rerunPrompt", () => {
  test("a check is run again and logged as its own type", () => {
    expect(rerunPrompt("lint", "just lint", "ab")).toBe("Run `just lint` again and log the result with evidence_log as lint evidence.");
  });

  test("a final verification names the plan's current bytes when they are known", () => {
    expect(rerunPrompt("final_verification", "just ci", "ab")).toBe(
      'Run the final verification again (`just ci`) and log the verdict with evidence_log as final_verification evidence with plan_sha256="ab".',
    );
    expect(rerunPrompt("final_verification", "just ci", null)).toBe(
      "Run the final verification again (`just ci`) and log the verdict with evidence_log as final_verification evidence.",
    );
  });
});

test("sha256Hex hashes the text's UTF-8 bytes", () => {
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const reference = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 100_000]) {
    const text = "a".repeat(length);
    expect([length, sha256Hex(text)]).toEqual([length, reference(text)]);
  }
  for (const text of ["é", "naïve plan ✓ ◐ ⊘", "🪨".repeat(40), "- [ ] 1. Task\r\n  - File: `src/a.ts`\n"]) {
    expect(sha256Hex(text)).toBe(reference(text));
  }
});
