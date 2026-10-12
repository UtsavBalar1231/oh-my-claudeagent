import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { planWriteDenial } from "../../src/core/plan-validate.ts";
import { inputText } from "../../src/core/tool-input.ts";
import { preToolUseDeny } from "./deny.ts";
import type { Handler } from "./registry.ts";

export const handle: Handler = (payload) => {
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "plan-write-guard")) return;
  const reason = planWriteDenial(inputText(payload, "tool_name"), payload.tool_input);
  return reason === undefined ? undefined : preToolUseDeny(reason);
};
