import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { classifierNote, exitCodeOf, isVerificationCommand, keepsSlot } from "../../src/core/verification.ts";
import type { Handler } from "./registry.ts";
import { ledgerMtimeSeconds, seconds, writeStatus } from "./status-file.ts";

const commandOf = (toolInput: unknown): string =>
  typeof toolInput === "object" && toolInput !== null && "command" in toolInput && typeof toolInput.command === "string"
    ? toolInput.command
    : "";

const SHELLS = new Set(["Bash", "PowerShell"]);

export const handle: Handler = (payload, { root, now, session }) => {
  const tool = payload.tool_name;
  if (typeof tool !== "string" || !SHELLS.has(tool)) return;
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "verification-recorder")) return;
  const command = commandOf(payload.tool_input);
  if (!isVerificationCommand(command)) return;
  if (session !== undefined && !keepsSlot(session.verification, ledgerMtimeSeconds(root), seconds(now))) {
    session.verification = { command, at: seconds(now), exit_code: exitCodeOf(payload.tool_response) };
    writeStatus(root, session, now);
  }
  // The auto-mode classifier never sees tool results. This note is a static assertion about the
  // call's origin, never text from the call, since the classifier reads it as trusted input.
  return { hookSpecificOutput: { hookEventName: "PostToolUse", classifierContext: classifierNote(tool) } };
};
