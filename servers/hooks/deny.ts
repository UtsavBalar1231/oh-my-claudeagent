import type { Output } from "./registry.ts";

export const preToolUseDeny = (reason: string): Output => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});
