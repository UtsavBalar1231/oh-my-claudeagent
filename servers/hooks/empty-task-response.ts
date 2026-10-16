import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { field, text } from "../../src/core/tool-input.ts";
import type { Handler, Payload } from "./registry.ts";

export const POOR_OUTPUT =
  "[POOR AGENT OUTPUT] The agent returned no substantive report. A rate limit, server error, or kill arrives as a delegation error carrying the agent's partial work. Resume a resumable agent once with SendMessage and ask for its findings, evidence and limits, without repeating the investigation. Built-in Explore and Plan agents cannot be resumed; relaunch those. If the next reply is also empty, report the gap and use the available evidence instead of looping.";

// SubagentHandback fires on the subagent's own call, so its advice goes to the subagent itself.
export const POOR_HANDBACK = "Your hand-back is empty or stopped before delivering findings. Return the findings, evidence and remaining limits.";

// A report under 200 characters that opens with a transitional phrase stopped mid-work. Only the
// opening counts: a short report's `NEXT STEPS:` line is a section, not a stall.
const MAX_TRANSITIONAL = 200;
const TRANSITIONAL =
  /^(let me|now let me|i'll |good\.|now i|ok,? let me|checking|looking at|reading |searching|next,? |i need to|i should|let's |i want to|i'm going to|i will )/;

// The report travels in the SubagentHandback payload under auto mode; otherwise a completed Agent
// result carries it, while a launch acknowledgement or a pointer at a hand-back carries none.
function delivered(payload: Payload): string | undefined {
  if (payload.tool_name === "SubagentHandback") {
    return text(field(payload.tool_input, "message"));
  }
  const response = payload.tool_response;
  if (payload.tool_name !== "Agent" || field(response, "status") !== "completed" || field(response, "handback") === "send") return;
  const content = field(response, "content");
  const texts = Array.isArray(content) ? content.map((part) => field(part, "text")).filter((part) => typeof part === "string") : [];
  return texts.join("\n");
}

// Only the explicit harness prefix is metadata; reports may contain bracketed findings.
const withoutHarnessNote = (report: string): string => report.replace(/^\[harness:[^\n]*\](?:\n|$)/i, "");

function isPoor(report: string): boolean {
  if (report.trim() === "") return true;
  const lower = report.toLowerCase();
  return report.length < MAX_TRANSITIONAL && TRANSITIONAL.test(lower);
}

const advise = (additionalContext: string) => ({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } });

export const handle: Handler = (payload) => {
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "empty-task-response")) return;
  const found = delivered(payload);
  if (found === undefined) return;
  const isOwnHandback = payload.tool_name === "SubagentHandback" && Boolean(payload.agent_id);
  const report = withoutHarnessNote(found.replace(/\n+$/, ""));
  if (isPoor(report)) return advise(isOwnHandback ? POOR_HANDBACK : POOR_OUTPUT);
  return;
};
