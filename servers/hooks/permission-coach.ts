import { isHookDisabled } from "../../src/core/kill-switch.ts";
import type { Handler } from "./registry.ts";

export const handle: Handler = (payload) => {
  if (payload.tool_name !== "Bash" || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "permission-coach")) return;
  return { hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true } };
};
