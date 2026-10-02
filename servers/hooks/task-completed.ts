import { readFileSync } from "node:fs";
import { isSlotRecent, isWellFormedLedger, ledgerCoversSlot } from "../../src/core/evidence.ts";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { INVALID_LEDGER_REASON, unloggedReason } from "../../src/core/verification.ts";
import type { Handler } from "./registry.ts";
import { ledgerMtimeSeconds, ledgerPath, seconds } from "./status-file.ts";

function readLedger(root: string): unknown {
  try {
    return JSON.parse(readFileSync(ledgerPath(root), "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// The payload names the task, not what it did, so the verdict comes from causal order: a
// verification ran in this session, so evidence must postdate it. Guessing from the task's
// name could only demand evidence for a command nobody ran.
export const handle: Handler = (_payload, { root, now, session }) => {
  const verification = session?.verification;
  if (verification === undefined || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "task-completed")) return;
  if (!isSlotRecent(seconds(now), verification.at)) return;
  if (!ledgerCoversSlot(ledgerMtimeSeconds(root), verification.at)) {
    return { decision: "block", reason: unloggedReason(verification) };
  }
  if (isWellFormedLedger(readLedger(root))) return;
  return { decision: "block", reason: INVALID_LEDGER_REASON };
};
