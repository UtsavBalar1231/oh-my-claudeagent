import { describe, expect, test } from "bun:test";
import {
  EVIDENCE_TYPES,
  isSlotRecent,
  isWellFormedLedger,
  ledgerCoversSlot,
  MAX_SLOT_AGE_SECONDS,
  MTIME_SLACK_SECONDS,
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
