import { toolDetail } from "./mission.ts";
import { type GroupCall, type ShellReceipt, shellReceipt } from "./receipt.ts";
import { inputText } from "./tool-input.ts";
import { oneLine } from "./ui-kit.ts";
import { EVIDENCE_LOG_TOOL, isVerificationCommand } from "./verification.ts";

export const POOR_OUTPUT =
  "[POOR AGENT OUTPUT] The agent returned no substantive report. Resume it once with SendMessage and ask for its findings, evidence and limits, without repeating the investigation. The built-in Explore and Plan agents can finish without an ID to resume them by; relaunch one of those. If the next reply is also empty, report the gap and use the available evidence instead of looping.";

// A report under 200 characters that opens with a transitional phrase stopped mid-work. Only the
// opening counts: a short report's `NEXT STEPS:` line is a section, not a stall.
const MAX_TRANSITIONAL = 200;
const TRANSITIONAL =
  /^(let me|now let me|i'll |good\.|now i|ok,? let me|checking|looking at|reading |searching|next,? |i need to|i should|let's |i want to|i'm going to|i will )/;

/** The report without trailing blank lines and the harness's own leading note; a report may hold bracketed findings. */
export const reportBody = (report: string): string => report.replace(/\n+$/, "").replace(/^\[harness:[^\n]*\](?:\n|$)/i, "");

export function isPoorReport(report: string): boolean {
  if (report.trim() === "") return true;
  return report.length < MAX_TRANSITIONAL && TRANSITIONAL.test(report.toLowerCase());
}

/** A check's outcome, or `background` for one that returned while still running, whose result OMCA never sees. */
type Check = Omit<ShellReceipt, "state"> & { state: ShellReceipt["state"] | "background" };

/** What the mod saw one agent's tool calls do: the files it edited, its last check, and whether evidence was logged after that check. */
export type Seen = { edited: readonly string[]; check: Check | null; isLogged: boolean };

export const NOTHING_SEEN: Seen = { edited: [], check: null, isLogged: false };

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const SHELLS = new Set(["Bash", "PowerShell"]);
const SHOWN_FILES = 3;
const MAX_COMMAND = 120;

/** The record after one call that ran; a refused call never reaches it. */
export function seeCall(seen: Seen, call: GroupCall, root: string): Seen {
  if (EDIT_TOOLS.has(call.tool)) {
    const path = call.isErrored ? "" : toolDetail(call.tool, call.input, root);
    return path === "" || seen.edited.includes(path) ? seen : { ...seen, edited: [...seen.edited, path] };
  }
  if (call.tool === EVIDENCE_LOG_TOOL) return call.isErrored || seen.check === null ? seen : { ...seen, isLogged: true };
  const command = inputText(call.input, "command");
  if (call.isRunning && SHELLS.has(call.tool) && isVerificationCommand(command)) {
    return { ...seen, check: { command, state: "background", exitCode: null, summary: "" }, isLogged: false };
  }
  const check = shellReceipt(call);
  return check === null ? seen : { ...seen, check, isLogged: false };
}

function filesText(edited: readonly string[]): string {
  const shown = edited.slice(0, SHOWN_FILES).join(", ");
  const rest = edited.length - SHOWN_FILES;
  return `${edited.length} ${edited.length === 1 ? "file" : "files"} (${rest > 0 ? `${shown} and ${rest} more` : shown})`;
}

function checkText({ command, state, exitCode }: Check): string {
  const line = oneLine(command);
  const shown = `\`${line.length > MAX_COMMAND ? `${line.slice(0, MAX_COMMAND - 3)}...` : line}\``;
  if (state === "pass") return `last check ${shown} passed`;
  if (state === "stopped") return `last check ${shown} was stopped`;
  if (state === "background") return `last check ${shown} went to the background, so OMCA saw no result`;
  return exitCode === null ? `last check ${shown} failed` : `last check ${shown} failed with exit code ${exitCode}`;
}

/** One line of what the agent's tool calls did, or null when it edited nothing and ran no check. */
export function receiptLine(seen: Seen): string | null {
  if (seen.edited.length === 0 && seen.check === null) return null;
  const parts = [
    ...(seen.edited.length === 0 ? [] : [`edited ${filesText(seen.edited)}`]),
    seen.check === null ? "no test, build or lint command seen" :`${checkText(seen.check)}, ${seen.isLogged ? "with evidence logged after it" : "with no evidence logged after it"}`,
  ];
  return `[OMCA receipt] What this agent's tool calls did, as OMCA saw them, not as the agent reports: ${parts.join("; ")}.`;
}
