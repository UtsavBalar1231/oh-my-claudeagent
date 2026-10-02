import { guidanceTemplate } from "./guidance.ts";
import type { Handler } from "./registry.ts";

export const handle: Handler = (payload) => {
  if (payload.source !== "compact") return;
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: guidanceTemplate() } };
};
