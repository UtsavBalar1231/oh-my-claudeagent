import { commentGateMode, judgeWrite } from "../../src/core/comments.ts";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { inputText } from "../../src/core/tool-input.ts";
import { preToolUseDeny } from "./deny.ts";
import type { Handler } from "./registry.ts";

export const handle: Handler = (payload, { session }) => {
  const tool = inputText(payload, "tool_name");
  const mode = commentGateMode(process.env.OMCA_COMMENT_GATE);
  if ((tool !== "Write" && tool !== "Edit") || mode === "off" || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "comment-gate")) return;
  try {
    const slot = session === undefined ? undefined : (session.commentGate ??= {});
    const verdict = judgeWrite(mode, payload.tool_input, slot);
    if (verdict === undefined) return;
    if (verdict.kind === "deny") return preToolUseDeny(verdict.reason);
    if (verdict.wouldDeny !== undefined) {
      console.error(`omca: comment-gate would deny (${verdict.wouldDeny}) ${inputText(payload.tool_input, "file_path")}`);
    }
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: verdict.text } };
  } catch (error) {
    console.error("omca: comment-gate failed, so the write passes:", error);
  }
};
