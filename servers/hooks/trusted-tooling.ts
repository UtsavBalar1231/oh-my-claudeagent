import { inputText } from "../../src/core/tool-input.ts";
import { isTrustedTooling } from "../../src/core/trusted-tooling.ts";
import type { Handler } from "./registry.ts";

export const handle: Handler = (payload) => {
  if (payload.tool_name !== "Bash" || !isTrustedTooling(inputText(payload.tool_input, "command"))) return undefined;
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
};
