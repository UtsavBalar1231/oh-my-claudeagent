import { isHookDisabled } from "../../src/core/kill-switch.ts";
import type { Handler } from "./registry.ts";

// The payload's reason names the matched rule or a no-verdict text, never whether the rule was a
// hard or a soft deny, so every Bash denial gets the retry and the reason is shown with it.
export const handle: Handler = (payload) => {
  if (payload.tool_name !== "Bash" || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "permission-coach")) return;
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  return {
    hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true },
    ...(reason !== "" && { systemMessage: `Auto mode denied a Bash call (${reason}); OMCA told the model it may retry.` }),
  };
};
