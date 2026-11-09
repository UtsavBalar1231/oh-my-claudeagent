import { readFileSync } from "node:fs";
import { isSlotRecent, ledgerCoversSlot, provesTask, readLedger } from "../../src/core/evidence.ts";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { noPassingVerdictReason } from "../../src/core/refusals.ts";
import { INVALID_LEDGER_REASON, unloggedReason } from "../../src/core/verification.ts";
import { readOrNull } from "../io.ts";
import type { Handler, Output, Payload } from "./registry.ts";
import { ledgerMtimeSeconds, ledgerPath, readTaskList, seconds } from "./status-file.ts";

function finalTaskBlock({ task_id: taskId, session_id: sessionId }: Payload, root: string): Output | undefined {
  if (typeof taskId !== "string" || taskId === "" || typeof sessionId !== "string" || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "final-verification")) return undefined;
  const list = readTaskList(root, sessionId);
  const task = list.tasks.find(({ id }) => id === taskId);
  if (task?.isFinal !== true) return undefined;
  let text: string | null;
  try {
    text = readOrNull(ledgerPath(root));
  } catch (error) {
    console.error("omca: could not read the evidence ledger:", error);
    return { decision: "block", reason: INVALID_LEDGER_REASON };
  }
  const ledger = readLedger(text ?? "{}");
  if (ledger.kind === "refused") return { decision: "block", reason: INVALID_LEDGER_REASON };
  if (ledger.entries.some((entry) => provesTask(entry, { list: list.id, run: task.run, id: taskId }))) return undefined;
  return { decision: "block", reason: noPassingVerdictReason(taskId, task.subject, task.run) };
}

// The payload names the task, not what it did, so the verdict comes from causal order: a
// verification ran in this session, so evidence must postdate it. Guessing from the task's
// name could only demand evidence for a command nobody ran.
export const handle: Handler = (payload, { root, now, session }) => {
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "task-completed")) return;
  const finalBlock = finalTaskBlock(payload, root);
  if (finalBlock !== undefined) return finalBlock;
  const verification = session?.verification;
  if (verification === undefined || !isSlotRecent(seconds(now), verification.at)) return;
  if (!ledgerCoversSlot(ledgerMtimeSeconds(root), verification.at)) {
    return { decision: "block", reason: unloggedReason(verification) };
  }
  const ledger = readLedger(readFileSync(ledgerPath(root), "utf8"));
  if (ledger.kind === "ok" && ledger.entries.length > 0) return;
  return { decision: "block", reason: INVALID_LEDGER_REASON };
};
