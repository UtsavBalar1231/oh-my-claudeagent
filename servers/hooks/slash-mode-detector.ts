import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { SLASH_MODES } from "../../src/core/keywords.ts";
import type { Handler } from "./registry.ts";
import { announceOnce } from "./session-state.ts";

export const handle: Handler = (payload, { session }) => {
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "slash-mode-detector")) return;
  const mode = typeof payload.command_name === "string" ? SLASH_MODES.get(payload.command_name) : undefined;
  if (mode === undefined || !announceOnce(session, mode.name)) return;
  return { hookSpecificOutput: { hookEventName: "UserPromptExpansion", additionalContext: mode.banner } };
};
