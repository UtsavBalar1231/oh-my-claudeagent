import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { guidanceContext } from "./guidance.ts";
import type { Handler } from "./registry.ts";

export const handle: Handler = (payload, { root, now, session }) => {
  if (payload.source === "compact" && session !== undefined) session.compactedAt = now;
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "session-start")) return;
  if (payload.source !== "compact") return;
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: guidanceContext(root, session?.id) } };
};
