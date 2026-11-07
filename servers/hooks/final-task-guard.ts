import { readLedger } from "../../src/core/evidence.ts";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { field, inputText, isRecord } from "../../src/core/tool-input.ts";
import { readOrNull } from "../io.ts";
import { preToolUseDeny } from "./deny.ts";
import type { Handler } from "./registry.ts";
import { ledgerPath, readTasks } from "./status-file.ts";

// Completing the final task needs a passing verdict, which `TaskCompleted` enforces. Marking it blocked
// or deleting it fires no such event, so either needs a verdict of any outcome: a run can be abandoned, not dodged.
export const handle: Handler = (payload, { root }) => {
  if (payload.tool_name !== "TaskUpdate" || typeof payload.session_id !== "string" || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "final-verification")) return;
  const metadata = field(payload.tool_input, "metadata");
  const blocked = isRecord(metadata) ? metadata.blocked : undefined;
  const unmarks = isRecord(metadata) && Object.hasOwn(metadata, "final") && metadata.final !== true;
  if (!unmarks && inputText(payload.tool_input, "status") !== "deleted" && (typeof blocked !== "string" || blocked === "")) return;
  const taskId = inputText(payload.tool_input, "taskId");
  const task = readTasks(root, payload.session_id).find(({ id }) => id === taskId);
  if (task?.isFinal !== true) return;
  if (unmarks) return preToolUseDeny(`Task #${taskId} is the final task of run '${task.run}', and it stays final.`);
  const ledger = readLedger(readOrNull(ledgerPath(root)) ?? "{}");
  if (ledger.kind === "ok" && ledger.entries.some((entry) => entry.type === "final_verification" && entry.taskId === taskId)) return;
  return preToolUseDeny(
    `Task #${taskId} is the final task of run '${task.run}', and no final verification names it. Record the verdict first: evidence_log(evidence_type="final_verification", command="<what the review covered>", exit_code=<0 for COMPLETE, 1 for INCOMPLETE>, output_snippet="<verdict, and why the run stops here>", task_id="${taskId}").`,
  );
};
