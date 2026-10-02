import { isTrustedTooling } from "../../src/core/trusted-tooling.ts";
import type { Handler } from "./registry.ts";

export const handle: Handler = (payload) => {
  const input = payload.tool_input;
  const command =
    typeof input === "object" && input !== null && "command" in input && typeof input.command === "string"
      ? input.command
      : "";
  if (payload.tool_name !== "Bash" || !isTrustedTooling(command)) return undefined;
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
};
