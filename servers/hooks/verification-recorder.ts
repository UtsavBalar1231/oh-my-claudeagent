import { isSlotRecent } from "../../src/core/evidence.ts";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { inputText } from "../../src/core/tool-input.ts";
import {
  classifierNote,
  EVIDENCE_LOG_TOOL,
  exitCodeOf,
  failureExitCode,
  isVerificationCommand,
  keepsSlot,
  quotableCommand,
  type Verification,
} from "../../src/core/verification.ts";
import type { Handler } from "./registry.ts";
import { agentKey, MAIN_THREAD, type Session } from "./session-state.ts";
import { seconds, writeStatus } from "./status-file.ts";

const SHELLS = new Set(["Bash", "PowerShell"]);

function record(root: string, session: Session, agent: string, slot: Verification, now: number): void {
  const slots = (session.verifications ??= new Map());
  for (const [key, held] of slots) if (!isSlotRecent(slot.at, held.at)) slots.delete(key);
  if (keepsSlot(slots.get(agent), slot.at)) return;
  slots.set(agent, slot);
  if (agent === MAIN_THREAD) writeStatus(root, session, now);
}

// PostToolUse fires for evidence_log only once the entry is written: a refused call fires
// PostToolUseFailure instead (probed on 2.1.319).
function markLogged(root: string, session: Session, agent: string, now: number): void {
  const slot = session.verifications?.get(agent);
  if (slot === undefined || slot.evidence_logged) return;
  slot.evidence_logged = true;
  if (agent === MAIN_THREAD) writeStatus(root, session, now);
}

// A verification belongs to the agent that ran it, and only that agent's own evidence_log
// satisfies it: a subagent's run never blocks the main conversation, and a subagent's log never
// covers the main conversation's run.
export const handle: Handler = (payload, { root, now, session }) => {
  const tool = payload.tool_name;
  if (typeof tool !== "string" || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "verification-recorder")) return;
  const agent = agentKey(payload.agent_id);
  const isFailure = payload.event === "PostToolUseFailure";
  if (tool === EVIDENCE_LOG_TOOL) {
    if (!isFailure && session !== undefined) markLogged(root, session, agent, now);
    return;
  }
  if (!SHELLS.has(tool)) return;
  const command = inputText(payload.tool_input, "command");
  if (!isVerificationCommand(command)) return;
  const exitCode = isFailure ? failureExitCode(payload.error) : exitCodeOf(payload.tool_response);
  if (isFailure && exitCode === null) return;
  if (session !== undefined) {
    record(root, session, agent, { command: quotableCommand(command), at: seconds(now), exit_code: exitCode, evidence_logged: false }, now);
  }
  // The auto-mode classifier never sees tool results. This note is a static assertion about the
  // call's origin, never text from the call, since the classifier reads it as trusted input.
  return isFailure ? undefined : { hookSpecificOutput: { hookEventName: "PostToolUse", classifierContext: classifierNote(tool) } };
};
