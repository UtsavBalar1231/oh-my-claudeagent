import { guidanceTemplate, holdsSetupBlock } from "./guidance.ts";
import type { Handler } from "./registry.ts";

export const handle: Handler = (payload) => {
  if (payload.source !== "compact" || holdsSetupBlock()) return;
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: guidanceTemplate() } };
};
