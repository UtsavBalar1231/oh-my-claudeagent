import { describe, expect, test } from "bun:test";
import { FRESH_BACKOFF, spendBlock, type StopLedger, stepBackoff } from "./stop-ledger.ts";

describe("stop ledger", () => {
  test("spendBlock allows up to the cap, then refuses", () => {
    const ledger: StopLedger = new Map();
    expect(Array.from({ length: 7 }, () => spendBlock(ledger, "drift-guard"))).toEqual([true, true, true, true, true, false, false]);
    expect(ledger.get("drift-guard")).toBe(5);
  });

  test("spendBlock caps each gate independently", () => {
    const ledger: StopLedger = new Map([["drift-guard", 5]]);
    expect(spendBlock(ledger, "drift-guard")).toBe(false);
    expect(spendBlock(ledger, "final-verification")).toBe(true);
    expect([...ledger]).toEqual([
      ["drift-guard", 5],
      ["final-verification", 1],
    ]);
  });
});

describe("plan-continuation backoff", () => {
  const T = 1_786_000_000;

  test("the first block opens a window at a same-count run of 1", () => {
    expect(stepBackoff(FRESH_BACKOFF, 2, T)).toEqual({
      state: { consecutiveBlocks: 1, lastBlockAt: T, lastUnchecked: 2, sameCountRun: 1, isStagnated: false },
      isBlocking: true,
      isWindowReset: false,
    });
  });

  test("the cooldown is 5 s doubled per consecutive block", () => {
    const state = { consecutiveBlocks: 2, lastBlockAt: T, lastUnchecked: 2, sameCountRun: 1, isStagnated: false };
    expect(stepBackoff(state, 1, T + 19)).toEqual({ state, isBlocking: false, isWindowReset: false });
    expect(stepBackoff(state, 1, T + 20)).toEqual({
      state: { consecutiveBlocks: 3, lastBlockAt: T + 20, lastUnchecked: 1, sameCountRun: 1, isStagnated: false },
      isBlocking: true,
      isWindowReset: false,
    });
  });

  test("an unchanged count extends the same-count run", () => {
    const state = { consecutiveBlocks: 1, lastBlockAt: T, lastUnchecked: 2, sameCountRun: 1, isStagnated: false };
    expect(stepBackoff(state, 2, T + 10).state).toEqual({ consecutiveBlocks: 2, lastBlockAt: T + 10, lastUnchecked: 2, sameCountRun: 2, isStagnated: false });
  });

  test("a fourth Stop at an unchanged count stagnates for the rest of the session", () => {
    const state = { consecutiveBlocks: 3, lastBlockAt: T, lastUnchecked: 2, sameCountRun: 3, isStagnated: false };
    const stagnated = { ...state, isStagnated: true };
    expect(stepBackoff(state, 2, T + 40)).toEqual({ state: stagnated, isBlocking: false, isWindowReset: false });
    expect(stepBackoff(stagnated, 1, T + 100_000)).toEqual({ state: stagnated, isBlocking: false, isWindowReset: false });
  });

  test("the hard cap holds until 300 s pass since the last block, then restarts the window", () => {
    const capped = { consecutiveBlocks: 5, lastBlockAt: T, lastUnchecked: 2, sameCountRun: 1, isStagnated: false };
    expect(stepBackoff(capped, 1, T + 299)).toEqual({ state: capped, isBlocking: false, isWindowReset: false });
    expect(stepBackoff(capped, 1, T + 300)).toEqual({
      state: { consecutiveBlocks: 1, lastBlockAt: T + 300, lastUnchecked: 1, sameCountRun: 1, isStagnated: false },
      isBlocking: true,
      isWindowReset: true,
    });
  });

  test("a restarted window that meets stagnation records the restart and stops blocking", () => {
    const capped = { consecutiveBlocks: 5, lastBlockAt: T, lastUnchecked: 2, sameCountRun: 3, isStagnated: false };
    expect(stepBackoff(capped, 2, T + 300)).toEqual({ state: { ...capped, consecutiveBlocks: 0, isStagnated: true }, isBlocking: false, isWindowReset: true });
  });
});
