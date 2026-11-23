import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { isPoorReport, POOR_OUTPUT, reportBody } from "../../src/core/report-receipt.ts";
import { field, text } from "../../src/core/tool-input.ts";
import type { Handler } from "./registry.ts";

// SubagentHandback fires on the subagent's own call, so its advice goes to the subagent itself. The
// caller's side of a report is the mod's `agent.report` feature (`hooks/report-receipts.ts`).
export const POOR_HANDBACK = "Your hand-back is empty or stopped before delivering findings. Return the findings, evidence and remaining limits.";

const advise = (additionalContext: string) => ({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } });

export const handle: Handler = (payload) => {
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "empty-task-response")) return;
  if (payload.tool_name !== "SubagentHandback") return;
  const report = reportBody(text(field(payload.tool_input, "message")));
  if (!isPoorReport(report)) return;
  return advise(payload.agent_id ? POOR_HANDBACK : POOR_OUTPUT);
};
