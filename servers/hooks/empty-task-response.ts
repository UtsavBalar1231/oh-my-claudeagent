import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { isPoorReport, reportBody } from "../../src/core/report-receipt.ts";
import { field, text } from "../../src/core/tool-input.ts";
import { preToolUseDeny } from "./deny.ts";
import type { Handler } from "./registry.ts";

// A deny makes Claude Code tell the subagent to call SubagentHandback again, and a report refused on
// its last try reaches nobody, so each agent is refused once and its next hand-back goes through. The
// caller's side of a report is the mod's `agent.report` feature (`hooks/report-receipts.ts`).
export const POOR_HANDBACK =
  "Your hand-back is empty or stopped before delivering findings. Call SubagentHandback again with the findings, evidence and remaining limits.";

export const handle: Handler = (payload, { session }) => {
  if (payload.tool_name !== "SubagentHandback" || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "empty-task-response")) return;
  if (session === undefined || !isPoorReport(reportBody(text(field(payload.tool_input, "message"))))) return;
  const agent = text(payload.agent_id);
  if (session.refusedHandbacks?.has(agent)) return;
  (session.refusedHandbacks ??= new Set()).add(agent);
  return preToolUseDeny(POOR_HANDBACK);
};
