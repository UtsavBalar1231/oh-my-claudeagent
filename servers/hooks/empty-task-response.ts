import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { field, text } from "../../src/core/tool-input.ts";
import type { Handler, Payload } from "./registry.ts";

export const POOR_OUTPUT =
  "[POOR AGENT OUTPUT] The agent returned empty or trivially short text with no synthesis. A rate limit, server error, or kill would have arrived as a delegation error carrying the agent's partial work, so an empty result here means the agent ended its own turn without a deliverable, typically after spending its turns on tool calls. A finished agent keeps its history, so resume it once with SendMessage and ask only for its findings in the required output format; that reuses the work it already did, where a fresh agent would repeat it. Built-in Explore and Plan agents cannot be resumed, so relaunch those. If the resumed reply is also empty, proceed with what you have rather than messaging it again.";

// SubagentHandback fires on the subagent's own call, so its advice goes to the subagent itself.
export const POOR_HANDBACK = "Your hand-back is empty or misses required sections; hand back a complete report.";

const SECTIONS: Readonly<Record<string, readonly string[]>> = {
  executor: ["STATUS:", "CHANGES:", "EVIDENCE:"],
  explore: ["FILES:", "ANSWER:", "NEXT STEPS:"],
  oracle: ["RECOMMENDATION:", "ALTERNATIVES:", "RISKS:"],
  librarian: ["SOURCES:", "FINDINGS:", "APPLICABILITY:"],
};

// Under 50 characters a report carries no synthesis, unless it reads as a deliberate completion:
// re-querying a terse "Done." is what loops a finished agent.
const MIN_REPORT = 50;
const COMPLETION = /done|ending|complete|finished|no further|nothing (further|left|to do)|acknowledged|deliverable/;
// A report under 200 characters that opens with a transitional phrase stopped mid-work. Only the
// opening counts: a short report's `NEXT STEPS:` line is a section, not a stall.
const MAX_TRANSITIONAL = 200;
const TRANSITIONAL =
  /^(let me|now let me|i'll |good\.|now i|ok,? let me|checking|looking at|reading |searching|next,? |i need to|i should|let's |i want to|i'm going to|i will )/;

// The report travels in the SubagentHandback payload under auto mode; otherwise a completed Agent
// result carries it, while a launch acknowledgement or a pointer at a hand-back carries none.
function delivered(payload: Payload): { report: string; agentType: string } | undefined {
  if (payload.tool_name === "SubagentHandback") {
    return { report: text(field(payload.tool_input, "message")), agentType: text(payload.agent_type) };
  }
  const response = payload.tool_response;
  if (payload.tool_name !== "Agent" || field(response, "status") !== "completed" || field(response, "handback") === "send") return;
  const content = field(response, "content");
  const texts = Array.isArray(content) ? content.map((part) => field(part, "text")).filter((part) => typeof part === "string") : [];
  return { report: texts.join("\n"), agentType: text(field(payload.tool_input, "subagent_type")) };
}

// A harness note can be prepended as one bracketed line; the report is what follows it.
const withoutHarnessNote = (report: string): string => report.replace(/^\[[^\n]*\](?:\n|$)/, "");

function isPoor(report: string): boolean {
  if (report.trim() === "") return true;
  const lower = report.toLowerCase();
  if (report.length < MIN_REPORT && !COMPLETION.test(lower)) return true;
  return report.length < MAX_TRANSITIONAL && TRANSITIONAL.test(lower);
}

const advise = (additionalContext: string) => ({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } });

export const handle: Handler = (payload) => {
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "empty-task-response")) return;
  const found = delivered(payload);
  if (found === undefined) return;
  const isOwnHandback = payload.tool_name === "SubagentHandback" && Boolean(payload.agent_id);
  const report = withoutHarnessNote(found.report.replace(/\n+$/, ""));
  if (isPoor(report)) return advise(isOwnHandback ? POOR_HANDBACK : POOR_OUTPUT);
  const agentType = found.agentType.slice(found.agentType.lastIndexOf(":") + 1);
  const lower = report.toLowerCase();
  const missing = (SECTIONS[agentType] ?? []).filter((section) => !lower.includes(section.toLowerCase()));
  if (missing.length === 0) return;
  if (isOwnHandback) return advise(POOR_HANDBACK);
  return advise(
    `[ADVISORY] Agent '${agentType}' output is missing expected section headers: ${missing.join(" ")}. The required output format specifies these sections. Output may be incomplete or hard to parse downstream.`,
  );
};
