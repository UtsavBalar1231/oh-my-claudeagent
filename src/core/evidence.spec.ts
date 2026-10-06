import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  dayLabel,
  type Evidence,
  isSlotRecent,
  latestByType,
  ledgerCoversSlot,
  MAX_SLOT_AGE_SECONDS,
  MTIME_SLACK_SECONDS,
  nextTypeFilter,
  parseLedger,
  placeEntries,
  readLedger,
  rerunPrompt,
  shownIndices,
  verdictOf,
} from "./evidence.ts";
import { sha256Hex } from "./sha256.ts";
import { clockOf, dayOf } from "./ui-kit.ts";

const entry = {
  type: "test",
  command: "just ci",
  exit_code: 0,
  output_snippet: "10 passed",
  timestamp: "2026-10-02T12:05:00Z",
};

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

describe("readLedger", () => {
  test("returns the whole document and the well-formed entries, leaving a malformed one out of the entries only", () => {
    const text = JSON.stringify({ version: 1, note: "kept", entries: [entry, { type: "test" }, null] });
    const read = readLedger(text);
    expect(read).toMatchObject({ kind: "ok", document: { version: 1, note: "kept", entries: [entry, { type: "test" }, null] } });
    expect(read.kind === "ok" && read.entries.map((one) => one.command)).toEqual(["just ci"]);
  });

  test("a ledger without a version reads as version 1", () => {
    expect(readLedger(JSON.stringify({ entries: [entry] })).kind).toBe("ok");
  });

  test("a ledger without an entries list reads as no entries and keeps its document", () => {
    expect(readLedger("{}")).toEqual({ kind: "ok", document: {}, entries: [] });
  });

  test.each([
    ["text that is not JSON", "{", "unparseable"],
    ["null", "null", "shape"],
    ["an array", JSON.stringify([entry]), "shape"],
    ["entries that is not a list", '{"entries":{}}', "shape"],
    ["version 2", '{"version":2,"entries":[]}', "version"],
    ["a string version", '{"version":"1","entries":[]}', "version"],
    ["a null version", '{"version":null,"entries":[]}', "version"],
  ])("refuses %s", (_label, text, code) => {
    expect(readLedger(text)).toMatchObject({ kind: "refused", code });
  });

  test.each([
    ["an empty entries list", { entries: [] }],
    ["entries with no entry that is well formed", { entries: [{ type: "test" }, null, "test"] }],
  ])("reads %s as no entries", (_label, data) => {
    expect(readLedger(JSON.stringify(data))).toMatchObject({ kind: "ok", entries: [] });
  });

  test("an entry without output_snippet is still well formed", () => {
    const { output_snippet: _dropped, ...bare } = entry;
    const read = readLedger(JSON.stringify({ entries: [bare] }));
    expect(read.kind === "ok" && read.entries).toHaveLength(1);
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
    expect(() => parseLedger("{")).toThrow("it is not valid JSON");
    expect(() => parseLedger('{"version":2}')).toThrow('its "version" is 2, and only version 1 is supported');
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

test("latestByType says whether each proving type's newest run passed, in ledger type order, leaving out final verification and types never run", () => {
  const entries = [run({ type: "lint", exitCode: 1 }), run({ exitCode: 1 }), run({}), run({ type: "build", exitCode: 2 }), run({ type: "final_verification" })];
  expect(latestByType(entries)).toEqual([
    { type: "build", isPassing: false },
    { type: "test", isPassing: true },
    { type: "lint", isPassing: false },
  ]);
  expect(latestByType([])).toEqual([]);
});

test("nextTypeFilter steps through the types the ledger holds, then back to none", () => {
  const entries = [run({ type: "lint" }), run({}), run({ type: "final_verification" })];
  const steps: (string | null)[] = [];
  let current = nextTypeFilter(entries, null);
  while (current !== null) {
    steps.push(current);
    current = nextTypeFilter(entries, current);
  }
  expect(steps).toEqual(["test", "lint", "final_verification"]);
  expect(nextTypeFilter(entries, "build")).toBe("test");
  expect(nextTypeFilter([], null)).toBeNull();
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

const bytesOf = (text: string) => new TextEncoder().encode(text);
const serverDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// What the mod path does with `$.fs.read(path, { as: "bytes" })`.
const modBytes = (bytes: Uint8Array) => Uint8Array.from(atob(btoa(String.fromCharCode(...bytes))), (char) => char.charCodeAt(0));

test("sha256Hex hashes the bytes it is given", () => {
  expect(sha256Hex(bytesOf(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex(bytesOf("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 100_000]) {
    const bytes = bytesOf("a".repeat(length));
    expect([length, sha256Hex(bytes)]).toEqual([length, serverDigest(bytes)]);
  }
  for (const text of ["é", "naïve plan ✓ ◐ ⊘", "🪨".repeat(40), "- [ ] 1. Task\r\n  - File: `src/a.ts`\n"]) {
    expect(sha256Hex(bytesOf(text))).toBe(serverDigest(bytesOf(text)));
  }
});

test("a plan with a BOM, CRLF line endings and an invalid UTF-8 byte has one digest on the server path and the mod path", () => {
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytesOf("- [ ] 1. Task\r\n  - File: `src/a.ts`\r\n"), 0xff, 0x0a]);
  expect(sha256Hex(modBytes(bytes))).toBe(serverDigest(bytes));
});

test("an ASCII plan with LF endings and no BOM keeps its digest", () => {
  const plan = "# Plan\n\n- [ ] 1. Task\n";
  expect(sha256Hex(bytesOf(plan))).toBe("a892183894168d775be2863f3e50fff56d2bb24729d5c20bb8e00f99a5cbfdac");
});
