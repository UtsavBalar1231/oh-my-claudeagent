import { namesTask, readLedger } from "../../src/core/evidence.ts";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { internalFinalReason, noVerdictReason, stayFinalReason } from "../../src/core/refusals.ts";
import { field, inputText, isRecord } from "../../src/core/tool-input.ts";
import { INVALID_LEDGER_REASON } from "../../src/core/verification.ts";
import { readOrNull } from "../io.ts";
import { preToolUseDeny } from "./deny.ts";
import type { Handler } from "./registry.ts";
import { ledgerPath, readTaskList } from "./status-file.ts";

// Completing the final task needs a passing verdict, which `TaskCompleted` enforces. Marking it blocked
// or deleting it fires no such event, so either needs a verdict of any outcome: a run can be abandoned, not dodged.
export const handle: Handler = (payload, { root }) => {
  if (payload.tool_name !== "TaskUpdate" || typeof payload.session_id !== "string" || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "final-verification") || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "final-task-guard")) return;
  const metadata = field(payload.tool_input, "metadata");
  const blocked = isRecord(metadata) ? metadata.blocked : undefined;
  const unmarks = isRecord(metadata) && Object.hasOwn(metadata, "final") && metadata.final !== true;
  const hides = isRecord(metadata) && Boolean(metadata._internal);
  if (!unmarks && !hides && inputText(payload.tool_input, "status") !== "deleted" && (typeof blocked !== "string" || blocked === "")) return;
  const rawId = field(payload.tool_input, "taskId");
  const taskId = typeof rawId === "number" && Number.isFinite(rawId) ? String(rawId) : inputText(payload.tool_input, "taskId");
  const list = readTaskList(root, payload.session_id);
  const task = list.tasks.find(({ id }) => id === taskId);
  if (task?.isFinal !== true) return;
  if (unmarks) return preToolUseDeny(stayFinalReason(taskId, task.run));
  if (hides) return preToolUseDeny(internalFinalReason(taskId, task.run));
  let text: string | null;
  try {
    text = readOrNull(ledgerPath(root));
  } catch (error) {
    console.error("omca: could not read the evidence ledger:", error);
    return preToolUseDeny(INVALID_LEDGER_REASON);
  }
  const ledger = readLedger(text ?? "{}");
  if (ledger.kind === "refused") return preToolUseDeny(INVALID_LEDGER_REASON);
  if (ledger.entries.some((entry) => namesTask(entry, { list: list.id, run: task.run, id: taskId }))) return;
  return preToolUseDeny(noVerdictReason(taskId, task.run));
};
