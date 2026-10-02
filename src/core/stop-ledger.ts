export type StopGate = "plan-continuation" | "final-verification" | "drift-guard";

export type StopLedger = Map<StopGate, number>;

// Blocks a gate may spend before it fails open; it gets them back once its condition is met.
export const STOP_BLOCK_CAP = 5;

/** Spends one of the gate's blocks, or returns false once the cap is reached. */
export function spendBlock(ledger: StopLedger, gate: StopGate): boolean {
  const spent = ledger.get(gate) ?? 0;
  if (spent >= STOP_BLOCK_CAP) return false;
  ledger.set(gate, spent + 1);
  return true;
}

export type Backoff = {
  readonly consecutiveBlocks: number;
  readonly lastBlockAt: number;
  readonly lastUnchecked: number;
  readonly sameCountRun: number;
  readonly isStagnated: boolean;
};

export const FRESH_BACKOFF: Backoff = { consecutiveBlocks: 0, lastBlockAt: 0, lastUnchecked: -1, sameCountRun: 0, isStagnated: false };

const BASE_COOLDOWN_SECONDS = 5;
const CLEAN_WINDOW_SECONDS = 300;
// This many blocks in a row at one unchecked count means the nudges are not producing progress.
const STAGNATION_STREAK = 3;

export type BackoffStep = { state: Backoff; isBlocking: boolean; isWindowReset: boolean };

/**
 * The plan-continuation backoff: a cooldown of 5 s doubling per consecutive block, a hard cap
 * of `STOP_BLOCK_CAP` blocks that a 300 s quiet window resets, and a permanent escape once
 * `STAGNATION_STREAK` blocks in a row saw the same unchecked count.
 */
export function stepBackoff(state: Backoff, unchecked: number, nowSeconds: number): BackoffStep {
  const hold = { state, isBlocking: false, isWindowReset: false };
  if (state.isStagnated) return hold;
  const sinceLastBlock = nowSeconds - state.lastBlockAt;
  const isWindowReset = state.consecutiveBlocks >= STOP_BLOCK_CAP;
  if (isWindowReset && sinceLastBlock < CLEAN_WINDOW_SECONDS) return hold;
  const consecutiveBlocks = isWindowReset ? 0 : state.consecutiveBlocks;
  if (sinceLastBlock < BASE_COOLDOWN_SECONDS * 2 ** consecutiveBlocks) return hold;
  const isSameCount = unchecked === state.lastUnchecked;
  if (isSameCount && state.sameCountRun >= STAGNATION_STREAK) {
    return { state: { ...state, consecutiveBlocks, isStagnated: true }, isBlocking: false, isWindowReset };
  }
  return {
    state: {
      consecutiveBlocks: consecutiveBlocks + 1,
      lastBlockAt: nowSeconds,
      lastUnchecked: unchecked,
      sameCountRun: isSameCount ? state.sameCountRun + 1 : 1,
      isStagnated: false,
    },
    isBlocking: true,
    isWindowReset,
  };
}
