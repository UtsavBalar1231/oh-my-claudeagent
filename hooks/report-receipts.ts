import { isHookDisabled } from "../src/core/kill-switch.ts";
import { isPoorReport, NOTHING_SEEN, POOR_OUTPUT, receiptLine, reportBody, type Seen, seeCall } from "../src/core/report-receipt.ts";
import { field } from "../src/core/tool-input.ts";
import type { Features } from "./dispatch.ts";
import { sessionOf } from "./host.ts";

const MAX_AGENTS = 64;

// A module value: a reload starts it over, so a receipt names only the calls seen since.
const seen = new Map<string, Seen>();

export const reportReceipts: Features = {
  "tool.call": {
    async post(host, e, result) {
      if (e.agentId === undefined || result.deny !== undefined) return undefined;
      const isErrored = result.isError === true;
      const isRunning = typeof field(result.result, "backgroundTaskId") === "string" || field(result.result, "backgroundedForAgentReport") === true;
      const call = { tool: e.tool, input: e, isRunning, isErrored, isInterrupted: field(result.result, "interrupted") === true, output: isErrored ? result.text : result.result };
      seen.set(e.agentId, seeCall(seen.get(e.agentId) ?? NOTHING_SEEN, call, await host.session.root()));
      for (const oldest of seen.keys()) {
        if (seen.size <= MAX_AGENTS) break;
        seen.delete(oldest);
      }
      return undefined;
    },
  },
  "agent.report": {
    async post(host, e, result) {
      if (result.consumed !== undefined) return undefined;
      const { disabledHooks } = await sessionOf(host);
      const record = seen.get(e.agentId);
      const isPoor = e.status === "completed" && e.subagentType !== "web-fetch" && !isHookDisabled(disabledHooks, "empty-task-response") && isPoorReport(reportBody(e.text));
      const receipt = record === undefined || isHookDisabled(disabledHooks, "report-receipts") ? null : receiptLine(record);
      const notes = [...(isPoor ? [POOR_OUTPUT] : []), ...(receipt === null ? [] : [receipt])];
      if (notes.length === 0) return undefined;
      return { ...result, text: [result.text.trimEnd(), ...notes].filter((part) => part !== "").join("\n\n") };
    },
  },
};
